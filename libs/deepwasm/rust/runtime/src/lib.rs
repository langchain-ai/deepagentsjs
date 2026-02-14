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

use std::sync::Mutex;

use anyhow::Error as AnyhowError;
use once_cell::sync::Lazy;
use sha2::Digest;
use wasm_bindgen::prelude::wasm_bindgen;
use wasmer_wasix::runtime::resolver::{DistributionInfo, PackageInfo, PackageSummary, WebcHash};

/// The URL used by worker threads to import the SDK.
/// Defaults to `"index.mjs"` (works in browsers). For Node.js, the host must
/// call `setSdkUrl()` with an absolute `file://` URL before spawning workers.
pub(crate) static SDK_URL: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new("index.mjs".to_string()));

pub(crate) const USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));
pub(crate) const DEFAULT_RUST_LOG: &[&str] = &["warn"];

#[wasm_bindgen(start, skip_typescript)]
fn on_start() {
    std::panic::set_hook(Box::new(|p| {
        tracing::error!("{p}");
        console_error_panic_hook::hook(p);
    }));
}

/// Set the URL that worker threads use to import the SDK.
/// In Node.js, call this with an absolute `file://` path to `deepwasm_runtime.js`
/// before loading any packages or spawning workers.
#[wasm_bindgen(js_name = "setSdkUrl")]
pub fn set_sdk_url(url: &str) {
    *SDK_URL.lock().unwrap() = url.to_string();
}

/// Register a local .webc package for offline dependency resolution.
/// Called from JS: `registerLocalPackage("wasmer/coreutils@1.0.19", bytes)`
#[wasm_bindgen(js_name = "registerLocalPackage")]
pub fn register_local_package(name: &str, bytes: &[u8]) -> Result<(), utils::Error> {
    // Parse name@version
    let (pkg_name, pkg_version) = name
        .rsplit_once('@')
        .ok_or_else(|| AnyhowError::msg(format!("Expected name@version, got: {name}")))?;

    // Parse the .webc container from bytes
    let version_webc =
        webc::detect(&mut &bytes[..]).map_err(|e| AnyhowError::msg(format!("Invalid webc: {e}")))?;
    let container =
        webc::Container::from_bytes_and_version(bytes::Bytes::copy_from_slice(bytes), version_webc)
            .map_err(|e| AnyhowError::msg(format!("Failed to parse webc: {e}")))?;

    // Build PackageInfo from the container's manifest
    let named_id = wasmer_config::package::NamedPackageId::try_new(pkg_name, pkg_version)
        .map_err(|e| AnyhowError::msg(format!("Invalid version '{pkg_version}': {e}")))?;
    let id = wasmer_config::package::PackageId::Named(named_id);
    let manifest = container.manifest();
    let pkg_info = PackageInfo::from_manifest(id, manifest, container.version())
        .map_err(|e| AnyhowError::msg(format!("Failed to extract PackageInfo: {e}")))?;

    // Compute SHA256 hash of the raw bytes
    let hash_bytes: [u8; 32] = sha2::Sha256::digest(bytes).into();
    let webc_sha256 = WebcHash::from_bytes(hash_bytes);

    // Create a fake file:// URL for this package
    let webc_url = url::Url::parse(&format!("file:///local/{name}"))
        .map_err(|e| AnyhowError::msg(format!("Failed to create URL: {e}")))?;

    let summary = PackageSummary {
        pkg: pkg_info,
        dist: DistributionInfo {
            webc: webc_url.clone(),
            webc_sha256,
        },
    };

    // Register in the global InMemorySource
    runtime::GLOBAL_SOURCE.lock().unwrap().add(summary);

    // Store the container in the global store for the PackageLoader
    runtime::GLOBAL_CONTAINERS
        .lock()
        .unwrap()
        .insert(webc_url, container);

    tracing::info!("Registered local package: {name}");
    Ok(())
}
