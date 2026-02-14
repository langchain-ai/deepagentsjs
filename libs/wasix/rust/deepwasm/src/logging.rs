use std::io::{ErrorKind, Write};

use tokio::sync::mpsc;
use tracing_subscriber::{
    fmt::{format::FmtSpan, MakeWriter},
    EnvFilter,
};
use wasm_bindgen::{prelude::wasm_bindgen, JsValue};

/// Initialize the logger used by `@wasmer/wasix`.
///
/// This function can only be called once. Subsequent calls will raise an
/// exception.
///
/// ## Filtering Logs
///
/// The `filter` string can be used to tweak logging verbosity, both globally
/// or on a per-module basis, and follows [the `$RUST_LOG` format][format].
///
/// Some examples:
/// - `off` - turn off all logs
/// - `error`, `warn`, `info`, `debug`, `trace` - set the global log level
/// - `wasmer_wasix` - enable logs for `wasmer_wasix`
/// - `info,wasmer_js::package_loader=trace` - set the global log level to
///   `info` and set `wasmer_js::package_loader` to `trace`
/// - `wasmer_js=debug/flush` -  turns on debug logging for
///   `wasmer_js` where the log message includes `flush`
/// - `warn,wasmer=info,wasmer_wasix::syscalls::wasi=trace` - directives can be
///   mixed arbitrarily
///
/// When no `filter` string is provided, a useful default will be used.
///
/// [format]: https://docs.rs/tracing-subscriber/latest/tracing_subscriber/filter/struct.EnvFilter.html#directives
#[wasm_bindgen(js_name = "initializeLogger")]
pub fn initialize_logger(filter: Option<String>) -> Result<(), crate::utils::Error> {
    let max_level = tracing::level_filters::STATIC_MAX_LEVEL
        .into_level()
        .unwrap_or(tracing::Level::ERROR);

    let filter = EnvFilter::builder()
        .with_regex(false)
        .with_default_directive(max_level.into())
        .parse_lossy(filter.unwrap_or_else(|| crate::DEFAULT_RUST_LOG.join(",")));

    tracing_subscriber::fmt::fmt()
        .with_writer(ConsoleLogger::spawn())
        .with_env_filter(filter)
        .with_span_events(FmtSpan::CLOSE)
        .without_time()
        .try_init()
        .map_err(|e| anyhow::anyhow!(e))?;

    Ok(())
}

/// A [`std::io::Write`] implementation which will pass all messages to the main
/// thread for logging with [`web_sys::console`].
///
/// This is useful when using Web Workers for concurrency because their
/// `console.log()` output isn't normally captured by test runners.
#[derive(Debug)]
struct ConsoleLogger {
    buffer: Vec<u8>,
    sender: mpsc::UnboundedSender<String>,
}

impl ConsoleLogger {
    fn spawn() -> impl for<'w> MakeWriter<'w> + 'static {
        let (sender, mut receiver) = mpsc::unbounded_channel();

        wasm_bindgen_futures::spawn_local(async move {
            while let Some(msg) = receiver.recv().await {
                let js_string = JsValue::from(msg);
                web_sys::console::log_1(&js_string);
            }
        });

        move || ConsoleLogger {
            buffer: Vec::new(),
            sender: sender.clone(),
        }
    }
}

impl Write for ConsoleLogger {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let buffer = std::mem::take(&mut self.buffer);

        let text = String::from_utf8(buffer)
            .map_err(|e| std::io::Error::new(ErrorKind::InvalidInput, e))?;

        self.sender
            .send(text)
            .map_err(|e| std::io::Error::new(ErrorKind::BrokenPipe, e))?;

        Ok(())
    }
}

impl Drop for ConsoleLogger {
    fn drop(&mut self) {
        if !self.buffer.is_empty() {
            let _ = self.flush();
        }
    }
}
