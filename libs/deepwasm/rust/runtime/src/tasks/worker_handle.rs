use std::fmt::Debug;

use anyhow::{Context, Error};
use js_sys::JsString;
use once_cell::sync::Lazy;
use wasm_bindgen::{prelude::Closure, JsCast, JsValue};

use crate::tasks::{PostMessagePayload, Scheduler, SchedulerMessage, WorkerMessage};

/// A handle to a running [`web_sys::Worker`].
///
/// This provides a structured way to communicate with the worker and will
/// automatically call [`web_sys::Worker::terminate()`] when dropped.
#[derive(Debug)]
pub(crate) struct WorkerHandle {
    id: u32,
    inner: web_sys::Worker,
}

impl WorkerHandle {
    pub(crate) fn spawn(worker_id: u32, sender: Scheduler) -> Result<Self, Error> {
        let name = format!("worker-{worker_id}");

        let worker_url = worker_url();
        let worker = web_sys::Worker::new_with_options(
            &worker_url,
            web_sys::WorkerOptions::new()
                .name(&name)
                .type_(web_sys::WorkerType::Module),
        )
        .map_err(crate::utils::js_error)?;

        let on_message: Closure<dyn FnMut(web_sys::MessageEvent)> = Closure::new({
            let sender = sender.clone();
            move |msg: web_sys::MessageEvent| {
                on_message(msg, &sender, worker_id);
            }
        });
        let on_message: js_sys::Function = on_message.into_js_value().unchecked_into();
        worker.set_onmessage(Some(&on_message));

        let on_error: Closure<dyn FnMut(web_sys::ErrorEvent)> =
            Closure::new(move |msg| on_error(msg, worker_id));
        let on_error: js_sys::Function = on_error.into_js_value().unchecked_into();
        worker.set_onerror(Some(&on_error));

        // The worker has technically been started, but it's kinda useless
        // because it hasn't been initialized with the same WebAssembly module
        // and linear memory as the scheduler. We need to initialize explicitly.
        init_message(worker_id)
            .and_then(|msg| worker.post_message(&msg))
            .map_err(crate::utils::js_error)?;

        Ok(WorkerHandle {
            id: worker_id,
            inner: worker,
        })
    }

    pub(crate) fn id(&self) -> u32 {
        self.id
    }

    /// Send a message to the worker.
    pub(crate) fn send(&self, msg: PostMessagePayload) -> Result<(), Error> {
        tracing::trace!(?msg, worker.id = self.id(), "sending a message to a worker");
        let js = msg.into_js().map_err(|e| e.into_anyhow())?;

        self.inner
            .post_message(&js)
            .map_err(crate::utils::js_error)?;

        Ok(())
    }
}

#[tracing::instrument(level = "trace", skip_all, fields(worker.id=worker_id))]
fn on_error(msg: web_sys::ErrorEvent, worker_id: u32) {
    tracing::error!(
        error = %msg.message(),
        filename = %msg.filename(),
        line_number = %msg.lineno(),
        column = %msg.colno(),
        "An error occurred",
    );
}

#[tracing::instrument(level = "trace", skip_all, fields(worker.id=worker_id))]
fn on_message(msg: web_sys::MessageEvent, sender: &Scheduler, worker_id: u32) {
    // Safety: The only way we can receive this message is if it was from the
    // worker, because we are the ones that spawned the worker, we can trust
    // the messages it emits.
    let result = unsafe { WorkerMessage::try_from_js(msg.data()) }
        .map_err(|e| crate::utils::js_error(e.into()))
        .context("Unable to parse the worker message")
        .and_then(|base_msg| {
            tracing::trace!(
                ?base_msg,
                worker.id = worker_id,
                "Received a message from worker"
            );

            if sender.is_closed() && matches!(&base_msg, WorkerMessage::MarkIdle) {
                tracing::warn!("Scheduler is closed, dropping message {:?}", msg);
                return Ok(());
            }

            let msg = match base_msg {
                WorkerMessage::MarkBusy => SchedulerMessage::WorkerBusy { worker_id },
                WorkerMessage::MarkIdle => SchedulerMessage::WorkerIdle { worker_id },
                WorkerMessage::Scheduler(msg) => msg,
            };
            sender.send(msg).map_err(|_| Error::msg("Send failed"))
        });

    if let Err(e) = result {
        tracing::warn!(
            error = &*e,
            // msg.origin = msg.origin(),
            // msg.last_event_id = msg.last_event_id(),
            "Unable to handle a message from the worker",
        );
    }
}

impl Drop for WorkerHandle {
    fn drop(&mut self) {
        tracing::debug!(id = self.id(), "Terminating worker");
        self.inner.terminate();
    }
}

/// Craft the special `"init"` message.
fn init_message(id: u32) -> Result<JsValue, JsValue> {
    let msg = js_sys::Object::new();

    js_sys::Reflect::set(&msg, &JsString::from("type"), &JsString::from("init"))?;
    js_sys::Reflect::set(&msg, &JsString::from("memory"), &wasm_bindgen::memory())?;
    js_sys::Reflect::set(&msg, &JsString::from("id"), &JsValue::from(id))?;
    js_sys::Reflect::set(&msg, &JsString::from("sdkUrl"), &JsValue::from(sdk_url()))?;
    js_sys::Reflect::set(
        &msg,
        &JsString::from("module"),
        &crate::utils::current_module(),
    )?;

    Ok(msg.into())
}

// fn import_meta_url() -> String {
//     #[wasm_bindgen]
//     #[allow(non_snake_case)]
//     extern "C" {
//         #[wasm_bindgen(js_namespace = ["import", "meta"], js_name = url)]
//         static IMPORT_META_URL: String;
//     }

//     IMPORT_META_URL.to_string()
// }

/// The URL used by the bootstrapping script to import the Wasmer SDK.
fn sdk_url() -> String {
    crate::SDK_URL.lock().unwrap().clone()
}

/// The URL for the worker.
fn worker_url() -> String {
    DEFAULT_WORKER_URL.to_string()
}

/// A data URL containing our worker's bootstrap script.
/// Uses a data URL instead of a blob URL for Node.js compatibility
/// (the `web-worker` polyfill does not support blob URLs).
static DEFAULT_WORKER_URL: Lazy<String> = Lazy::new(|| {
    let script = include_str!("../../../../src/worker.js");
    let encoded = js_sys::encode_uri_component(script);
    format!("data:application/javascript,{}", encoded.as_string().unwrap_or_default())
});
