use anyhow::Context;
use bytes::BytesMut;
use futures::{future::Either, Stream};
use js_sys::{JsString, Promise, Reflect, Uint8Array};
use tracing::Instrument;
use virtual_fs::{AsyncReadExt, AsyncWriteExt, Pipe};
use wasm_bindgen::{prelude::wasm_bindgen, JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    ReadableStream, ReadableStreamDefaultController, ReadableStreamDefaultReader, WritableStream,
};

use crate::utils::Error;

/// Set up a pipe where data written from JavaScript can be read by the WASIX
/// process.
pub(crate) fn input_pipe() -> (Pipe, WritableStream) {
    let (left, right) = Pipe::channel();

    let sink = JsValue::from(WritableStreamSink { pipe: right });

    let callback: wasm_bindgen::prelude::Closure<dyn Fn(Uint8Array) -> f64> =
        wasm_bindgen::closure::Closure::new(|chunk: Uint8Array| chunk.byte_length() as f64);

    let stream = WritableStream::new_with_underlying_sink_and_strategy(
        sink.unchecked_ref(),
        web_sys::QueuingStrategy::new()
            .high_water_mark(256.0)
            .size(callback.into_js_value().unchecked_ref()),
    )
    .unwrap();

    (left, stream)
}

#[derive(Debug)]
#[wasm_bindgen(skip_typescript)]
struct WritableStreamSink {
    pipe: Pipe,
}

#[wasm_bindgen]
impl WritableStreamSink {
    /// This method, also defined by the developer, will be called if the app
    /// signals that it has finished writing chunks to the stream. The contents
    /// should do whatever is necessary to finalize writes to the underlying
    /// sink, and release access to it. If this process is asynchronous, it can
    /// return a promise to signal success or failure. This method will be
    /// called only after all queued-up writes have succeeded.
    pub fn close(&mut self) -> Promise {
        let mut pipe = self.pipe.clone();

        wasm_bindgen_futures::future_to_promise(
            async move {
                pipe.flush()
                    .await
                    .context("Flushing failed")
                    .map_err(Error::from)?;
                pipe.close();
                tracing::debug!("Pipe closed");

                Ok(JsValue::UNDEFINED)
            }
            .in_current_span()
            .instrument(tracing::debug_span!("close")),
        )
    }

    /// This method, also defined by the developer, will be called if the app
    /// signals that it wishes to abruptly close the stream and put it in an
    /// errored state. It can clean up any held resources, much like close(),
    /// but abort() will be called even if writes are queued up — those chunks
    /// will be thrown away. If this process is asynchronous, it can return a
    /// promise to signal success or failure. The reason parameter contains a
    /// string describing why the stream was aborted.
    pub fn abort(&mut self, reason: JsString) {
        tracing::debug!(%reason, "Aborting the stream");
        self.pipe.close();
    }

    /// This method, also defined by the developer, will be called when a new
    /// chunk of data (specified in the chunk parameter) is ready to be written
    /// to the underlying sink. It can return a promise to signal success or
    /// failure of the write operation. This method will be called only after
    /// previous writes have succeeded, and never after the stream is closed or
    /// aborted (see below).
    pub fn write(&mut self, chunk: Uint8Array) -> Promise {
        let mut pipe = self.pipe.clone();
        let data = chunk.to_vec();

        wasm_bindgen_futures::future_to_promise(
            async move {
                tracing::trace!(
                    bytes_written = data.len(),
                    ?data,
                    data_utf8 = String::from_utf8_lossy(&data).as_ref(),
                );

                pipe.write_all(&data)
                    .await
                    .context("Write failed")
                    .map_err(Error::from)?;
                Ok(JsValue::UNDEFINED)
            }
            .in_current_span()
            .instrument(tracing::trace_span!("write")),
        )
    }
}

/// Set up a pipe where the WASIX pipe writes data that will be read from
/// JavaScript.
pub(crate) fn output_pipe() -> (Pipe, ReadableStream) {
    let (left, right) = Pipe::channel();

    let source = JsValue::from(ReadableStreamSource { pipe: right });

    let callback: wasm_bindgen::prelude::Closure<dyn Fn(Uint8Array) -> f64> =
        wasm_bindgen::closure::Closure::new(|chunk: Uint8Array| chunk.byte_length() as f64);

    let stream = ReadableStream::new_with_underlying_source_and_strategy(
        source.unchecked_ref(),
        web_sys::QueuingStrategy::new()
            .high_water_mark(256.0)
            .size(callback.into_js_value().unchecked_ref()),
    )
    .unwrap();

    (left, stream)
}

#[derive(Debug)]
#[wasm_bindgen(skip_typescript)]
struct ReadableStreamSource {
    pipe: Pipe,
}

#[wasm_bindgen]
impl ReadableStreamSource {
    /// This method, also defined by the developer, will be called repeatedly
    /// when the stream's internal queue of chunks is not full, up until it
    /// reaches its high water mark. If pull() returns a promise, then it won't
    /// be called again until that promise fulfills; if the promise rejects, the
    /// stream will become errored. The controller parameter passed to this
    /// method is a ReadableStreamDefaultController or a
    /// ReadableByteStreamController, depending on the value of the type
    /// property. This can be used by the developer to control the stream as
    /// more chunks are fetched. This function will not be called until start()
    /// successfully completes. Additionally, it will only be called repeatedly
    /// if it enqueues at least one chunk or fulfills a BYOB request; a no-op
    /// pull() implementation will not be continually called.
    pub fn pull(&mut self, controller: ReadableStreamDefaultController) -> Promise {
        let mut pipe = self.pipe.clone();

        wasm_bindgen_futures::future_to_promise(
            async move {
                /// The maximum buffer size we will allow - helps avoid OOMs.
                const MAX_CAPACITY: usize = 10_000_000;

                let capacity = controller
                    .desired_size()
                    .map(|size| std::cmp::min(size as usize, MAX_CAPACITY))
                    .unwrap_or(128);
                let mut buffer = BytesMut::with_capacity(capacity);

                match pipe.read_buf(&mut buffer).await.context("Read failed") {
                    Ok(0) => {
                        tracing::debug!("EOF");
                        controller.close()?;
                    }
                    Ok(bytes_read) => {
                        let data = &buffer[..bytes_read];
                        tracing::trace!(
                            bytes_read,
                            ?data,
                            data_utf8 = String::from_utf8_lossy(data).as_ref()
                        );

                        let buffer = Uint8Array::from(data);
                        controller.enqueue_with_chunk(&buffer)?;
                    }
                    Err(e) => {
                        tracing::debug!(error = &*e);
                        let err = JsValue::from(Error::from(e));
                        controller.error_with_e(&err);
                    }
                }

                Ok(JsValue::UNDEFINED)
            }
            .in_current_span()
            .instrument(tracing::trace_span!("pull")),
        )
    }

    /// This method, also defined by the developer, will be called if the app
    /// signals that the stream is to be cancelled (e.g. if
    /// ReadableStream.cancel() is called). The contents should do whatever is
    /// necessary to release access to the stream source. If this process is
    /// asynchronous, it can return a promise to signal success or failure. The
    /// reason parameter contains a string describing why the stream was
    /// cancelled.
    pub fn cancel(&mut self) {
        tracing::debug!("Read stream cancelled");
        self.pipe.close();
    }

    /// This property controls what type of readable stream is being dealt with.
    /// If it is included with a value set to `"bytes"`, the passed controller
    /// object will be a `ReadableByteStreamController`` capable of handling a
    /// BYOB (bring your own buffer)/byte stream. If it is not included, the
    /// passed controller will be a `ReadableStreamDefaultController`.
    #[wasm_bindgen(getter, js_name = "type")]
    pub fn type_(&self) -> Option<JsString> {
        // Note: We can't use BYOB for zero-copy streaming because it'd mean
        // JavaScript code gets a reference to the buffer allocated inside the
        // pull() method. That Uint8Array is a view into a linear memory
        // and would any access after the pull method's promise completes would
        // be a use-after-free.
        //
        // This also works around a limitation in Safari where returning
        // JsString::from("bytes") causes the browser's *native* code to run the
        // constructor for ReadableByteStreamController, which isn't implemented
        // yet.
        None
    }
}

pub(crate) fn read_to_end(stream: ReadableStream) -> impl Stream<Item = Result<Vec<u8>, Error>> {
    let reader = match ReadableStreamDefaultReader::new(&stream) {
        Ok(reader) => reader,
        Err(_) => {
            tracing::trace!(
                "The ReadableStream is already locked. Leaving it up to the user to consume."
            );
            return Either::Left(futures::stream::empty());
        }
    };

    struct DropGuard(ReadableStreamDefaultReader);
    impl Drop for DropGuard {
        fn drop(&mut self) {
            // Make sure the reader lock always gets released so the caller
            // isn't left with an unusable stream
            self.0.release_lock();
        }
    }

    let stream = futures::stream::try_unfold(DropGuard(reader), move |reader| async {
        let next_chunk = JsFuture::from(reader.0.read()).await.map_err(Error::js)?;
        let chunk = get_chunk(next_chunk)?;
        Ok(chunk.map(|c| (c, reader)))
    });

    Either::Right(stream)
}

fn get_chunk(next_chunk: JsValue) -> Result<Option<Vec<u8>>, Error> {
    let done = JsValue::from_str("done");
    let value = JsValue::from_str("value");

    let done = Reflect::get(&next_chunk, &done).map_err(Error::js)?;
    if done.is_truthy() {
        return Ok(None);
    }

    let chunk = Reflect::get(&next_chunk, &value).map_err(Error::js)?;
    let chunk = Uint8Array::new(&chunk);

    Ok(Some(chunk.to_vec()))
}

#[cfg(test)]
mod tests {
    use futures::TryStreamExt;
    use wasm_bindgen_futures::JsFuture;
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    #[wasm_bindgen_test]
    async fn writing_to_the_pipe_is_readable_from_js() {
        let (mut pipe, stream) = output_pipe();

        pipe.write_all(b"Hello, World!").await.unwrap();
        pipe.close();

        let data = read_to_end(stream)
            .try_fold(Vec::new(), |mut buffer, chunk| async {
                buffer.extend(chunk);
                Ok(buffer)
            })
            .await
            .unwrap();
        assert_eq!(String::from_utf8(data).unwrap(), "Hello, World!");
    }

    #[wasm_bindgen_test]
    async fn multiple_writes_to_an_output_pipe_are_seen_by_js() {
        let (pipe, stream) = output_pipe();

        // Pretend to be a WASIX program writing to stdout in the background
        wasm_bindgen_futures::spawn_local({
            let mut pipe = pipe.clone();
            async move {
                pipe.write_all(b"Hello").await.unwrap();
                pipe.write_all(b", ").await.unwrap();
                pipe.write_all(b"World").await.unwrap();
                pipe.write_all(b"!").await.unwrap();
                pipe.close();
            }
        });

        // Pretend to be some JS code using the ReadableStream API to read from
        // stdout.
        let data = read_to_end(stream)
            .try_fold(Vec::new(), |mut buffer, chunk| async {
                buffer.extend(chunk);
                Ok(buffer)
            })
            .await
            .unwrap();
        assert_eq!(String::from_utf8(data).unwrap(), "Hello, World!");

        // Make sure one handle to the pipe stays alive until the very end (e.g.
        // because it was stored in the runtime).
        drop(pipe);
    }

    #[wasm_bindgen_test]
    async fn data_written_by_js_is_readable_from_the_pipe() {
        let (mut pipe, stream) = input_pipe();
        let chunk = Uint8Array::from(b"Hello, World!".as_ref());

        let writer = stream.get_writer().unwrap();
        JsFuture::from(writer.write_with_chunk(&chunk))
            .await
            .unwrap();
        JsFuture::from(writer.close()).await.unwrap();

        let mut data = String::new();
        pipe.read_to_string(&mut data).await.unwrap();

        assert_eq!(data, "Hello, World!");
    }
}
