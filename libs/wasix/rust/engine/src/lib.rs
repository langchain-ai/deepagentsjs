use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

mod fs;

#[cfg(not(target_arch = "wasm32"))]
pub mod runtime;

// Re-export filesystem types at the crate root
pub use fs::{DirEntry, FsMetadata};

#[cfg(target_arch = "wasm32")]
pub use fs::ProxyFileSystem;

#[cfg(not(target_arch = "wasm32"))]
pub use fs::{FsCallbacks, OpenFlags, ProxyFileSystem};

/// Result of executing a command in the WASIX runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteResult {
    pub output: String,
    pub exit_code: i32,
    pub truncated: bool,
}

/// Opaque handle to a WASIX runtime instance.
#[wasm_bindgen]
pub struct RuntimeHandle {
    id: u64,
    // On wasm32, we hold onto the ProxyFileSystem so it lives as long as the runtime.
    // On native, the ProxyFileSystem is stored differently (not wasm_bindgen).
    #[cfg(target_arch = "wasm32")]
    _fs: Option<fs::ProxyFileSystem>,
}

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Create a new WASIX runtime instance with a filesystem proxy.
///
/// The `fs_callbacks` parameter is a JS object with callback functions
/// for filesystem operations. See `ProxyFileSystem::new` for the expected
/// callback interface.
///
/// In the current skeleton this allocates a handle ID and stores the
/// ProxyFileSystem but does not initialise a real wasmer-wasix runtime.
#[wasm_bindgen]
pub fn create_runtime(fs_callbacks: JsValue) -> Result<RuntimeHandle, JsError> {
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    #[cfg(target_arch = "wasm32")]
    {
        let proxy_fs = if fs_callbacks.is_undefined() || fs_callbacks.is_null() {
            None
        } else {
            Some(fs::ProxyFileSystem::new(fs_callbacks)?)
        };
        Ok(RuntimeHandle {
            id,
            _fs: proxy_fs,
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = fs_callbacks; // Not used on native — tests construct ProxyFileSystem directly
        Ok(RuntimeHandle { id })
    }
}

#[wasm_bindgen]
impl RuntimeHandle {
    /// Returns the internal handle ID (useful for debugging).
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> u64 {
        self.id
    }
}

/// Execute a command string in the WASIX runtime.
///
/// Returns a JSON-serialized `ExecuteResult`. We return JSON rather than
/// a wasm-bindgen struct so the JS side gets a plain object without
/// needing generated wrapper classes for the result type.
///
/// Current skeleton: echoes the command back as output with exit code 0.
#[wasm_bindgen]
pub fn execute(command: &str) -> JsValue {
    let result = ExecuteResult {
        output: format!("stub: would execute `{}`\n", command),
        exit_code: 0,
        truncated: false,
    };
    serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execute_result_serialization() {
        let result = ExecuteResult {
            output: "hello".into(),
            exit_code: 0,
            truncated: false,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("hello"));
    }
}
