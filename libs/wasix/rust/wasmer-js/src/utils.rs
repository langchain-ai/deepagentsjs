use std::{
    collections::BTreeMap,
    fmt::{Debug, Display},
    num::NonZeroUsize,
};

use js_sys::{JsString, Promise, Uint8Array};

use wasm_bindgen::{prelude::wasm_bindgen, JsCast, JsValue};
use web_sys::{Window, WorkerGlobalScope};

/// Try to extract the most appropriate error message from a [`JsValue`],
/// falling back to a generic error message.
pub(crate) fn js_error(value: JsValue) -> anyhow::Error {
    if let Some(e) = value.dyn_ref::<js_sys::Error>() {
        anyhow::Error::msg(String::from(e.message()))
    } else if let Some(obj) = value.dyn_ref::<js_sys::Object>() {
        return anyhow::Error::msg(String::from(obj.to_string()));
    } else if let Some(s) = value.dyn_ref::<js_sys::JsString>() {
        return anyhow::Error::msg(String::from(s));
    } else {
        anyhow::anyhow!("An unknown error occurred: {value:?}")
    }
}

/// A strongly-typed wrapper around `globalThis`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum GlobalScope {
    Window(Window),
    Worker(WorkerGlobalScope),
    Other(js_sys::Object),
}

impl GlobalScope {
    pub fn current() -> Self {
        let global_scope = js_sys::global();

        match global_scope.dyn_into() {
            Ok(window) => GlobalScope::Window(window),
            Err(global_scope) => match global_scope.dyn_into() {
                Ok(worker_global_scope) => GlobalScope::Worker(worker_global_scope),
                Err(other) => GlobalScope::Other(other),
            },
        }
    }

    pub fn sleep(&self, milliseconds: i32) -> Promise {
        Promise::new(&mut |resolve, reject| match self {
            GlobalScope::Window(window) => {
                window
                    .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, milliseconds)
                    .unwrap();
            }
            GlobalScope::Worker(worker_global_scope) => {
                worker_global_scope
                    .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, milliseconds)
                    .unwrap();
            }
            GlobalScope::Other(_) => {
                let error = js_sys::Error::new("Unable to call setTimeout()");
                reject.call1(&reject, &error).unwrap();
            }
        })
    }

    pub fn user_agent(&self) -> Option<String> {
        match self {
            GlobalScope::Window(scope) => scope.navigator().user_agent().ok(),
            GlobalScope::Worker(scope) => scope.navigator().user_agent().ok(),
            GlobalScope::Other(_) => None,
        }
    }

    /// The amount of concurrency available on this system.
    ///
    /// Returns `None` if unable to determine the available concurrency.
    pub fn hardware_concurrency(&self) -> Option<NonZeroUsize> {
        let concurrency = match self {
            GlobalScope::Window(scope) => scope.navigator().hardware_concurrency(),
            GlobalScope::Worker(scope) => scope.navigator().hardware_concurrency(),
            GlobalScope::Other(_) => return None,
        };

        let concurrency = concurrency.round() as usize;
        NonZeroUsize::new(concurrency)
    }

    pub fn is_mobile(&self) -> bool {
        match self.user_agent() {
            Some(user_agent) => wasmer_wasix::os::common::is_mobile(&user_agent),
            None => false,
        }
    }

    pub fn cross_origin_isolated(&self) -> Option<bool> {
        let obj = self.as_object();
        js_sys::Reflect::get(obj, &JsValue::from_str("crossOriginIsolated"))
            .ok()
            .and_then(|obj| obj.as_bool())
    }

    fn as_object(&self) -> &js_sys::Object {
        match self {
            GlobalScope::Window(w) => w,
            GlobalScope::Worker(w) => w,
            GlobalScope::Other(obj) => obj,
        }
    }
}

/// A wrapper around [`anyhow::Error`] that can be returned to JS to raise
/// an exception.
#[derive(Debug)]
pub enum Error {
    Rust(anyhow::Error),
    JavaScript(JsValue),
}

impl Error {
    pub(crate) fn js(error: impl Into<JsValue>) -> Self {
        Error::JavaScript(error.into())
    }

    pub(crate) fn into_anyhow(self) -> anyhow::Error {
        match self {
            Error::Rust(e) => e,
            Error::JavaScript(js) => js_error(js),
        }
    }
}

impl<E: Into<anyhow::Error>> From<E> for Error {
    fn from(value: E) -> Self {
        Error::Rust(value.into())
    }
}

impl From<Error> for JsValue {
    fn from(error: Error) -> Self {
        match error {
            Error::JavaScript(e) => e,
            Error::Rust(error) => {
                let message = error.to_string();
                let js_error = js_sys::Error::new(&message);

                let _ = js_sys::Reflect::set(
                    &js_error,
                    &JsString::from("message"),
                    &JsString::from(error.to_string()),
                );

                let _ = js_sys::Reflect::set(
                    &js_error,
                    &JsString::from("detailedMessage"),
                    &JsString::from(format!("{error:?}")),
                );

                let causes: js_sys::Array = std::iter::successors(error.source(), |e| e.source())
                    .map(|e| JsString::from(e.to_string()))
                    .collect();
                let _ = js_sys::Reflect::set(&js_error, &JsString::from("causes"), &causes);

                js_error.into()
            }
        }
    }
}

impl Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Rust(e) => Display::fmt(e, f),
            Error::JavaScript(js) => {
                if let Some(e) = js.dyn_ref::<js_sys::Error>() {
                    write!(f, "{}", String::from(e.message()))
                } else if let Some(obj) = js.dyn_ref::<js_sys::Object>() {
                    write!(f, "{}", String::from(obj.to_string()))
                } else if let Some(s) = js.dyn_ref::<js_sys::JsString>() {
                    write!(f, "{}", String::from(s))
                } else {
                    write!(f, "A JavaScript error occurred")
                }
            }
        }
    }
}

pub(crate) fn object_entries(obj: &js_sys::Object) -> Result<BTreeMap<JsString, JsValue>, Error> {
    let mut entries = BTreeMap::new();

    for key in js_sys::Object::keys(obj) {
        let key: JsString = key
            .dyn_into()
            .map_err(|_| Error::js(js_sys::TypeError::new("Object keys should be strings")))?;
        let value = js_sys::Reflect::get(obj, &key).map_err(Error::js)?;
        entries.insert(key, value);
    }

    Ok(entries)
}

pub(crate) fn hidden<T>(_value: T, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("_")
}

/// Get a reference to the currently running module.
pub(crate) fn current_module() -> js_sys::WebAssembly::Module {
    // FIXME: Switch this to something stable and portable
    //
    // We use an undocumented API to get a reference to the
    // WebAssembly module that is being executed right now so start
    // a new thread by transferring the WebAssembly linear memory and
    // module to a worker and beginning execution.
    //
    // This can only be used in the browser. Trying to build
    // wasmer-wasix for NodeJS will probably result in the following:
    //
    // Error: executing `wasm-bindgen` over the wasm file
    //   Caused by:
    //   0: failed to generate bindings for import of `__wbindgen_placeholder__::__wbindgen_module`
    //   1: `wasm_bindgen::module` is currently only supported with `--target no-modules` and `--tar get web`
    wasm_bindgen::module().dyn_into().unwrap()
}

pub(crate) fn js_string_array(array: js_sys::Array) -> Result<Vec<String>, Error> {
    let mut parsed = Vec::new();

    for arg in array {
        match arg.dyn_into::<JsString>() {
            Ok(arg) => parsed.push(String::from(arg)),
            Err(_) => {
                return Err(Error::js(js_sys::TypeError::new(
                    "Expected an array of strings",
                )));
            }
        }
    }

    Ok(parsed)
}

pub(crate) fn js_record_of_strings(obj: &js_sys::Object) -> Result<Vec<(String, String)>, Error> {
    let mut parsed = Vec::new();

    for (key, value) in crate::utils::object_entries(obj)? {
        let key: String = key.into();
        let value: String = value
            .dyn_into::<JsString>()
            .map_err(|_| {
                Error::js(js_sys::TypeError::new(
                    "Expected an object mapping strings to strings",
                ))
            })?
            .into();
        parsed.push((key, value));
    }

    Ok(parsed)
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "string | Uint8Array")]
    pub type StringOrBytes;
}

impl StringOrBytes {
    pub fn as_bytes(&self) -> Vec<u8> {
        if let Some(s) = self.dyn_ref::<JsString>() {
            String::from(s).into()
        } else if let Some(buffer) = self.dyn_ref::<Uint8Array>() {
            buffer.to_vec()
        } else {
            unreachable!()
        }
    }
}
