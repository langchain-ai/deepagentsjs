// #![feature(once_cell_try)]

#[cfg(test)]
wasm_bindgen_test::wasm_bindgen_test_configure!(run_in_browser);

extern crate alloc;

pub mod fs;
mod instance;
mod js_runtime;
mod logging;
mod options;
mod package_loader;
mod run;
mod runtime;
mod streams;
mod tasks;
mod utils;
mod wasmer;

pub use crate::{
    fs::{Directory, DirectoryInit},
    instance::{Instance, JsOutput},
    js_runtime::{JsRuntime, RuntimeOptions},
    logging::initialize_logger,
    options::{RunOptions, SpawnOptions},
    run::run_wasix,
    utils::StringOrBytes,
    wasmer::Wasmer,
};

use wasm_bindgen::prelude::wasm_bindgen;

pub(crate) const USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));
pub(crate) const DEFAULT_RUST_LOG: &[&str] = &["warn"];

#[wasm_bindgen(start, skip_typescript)]
fn on_start() {
    std::panic::set_hook(Box::new(|p| {
        tracing::error!("{p}");
        console_error_panic_hook::hook(p);
    }));
}
