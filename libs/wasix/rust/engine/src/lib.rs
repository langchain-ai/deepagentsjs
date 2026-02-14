use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

mod fs;

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
}

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Create a new WASIX runtime instance and return a handle to it.
///
/// In the current skeleton this allocates a handle ID but does not
/// initialise a real runtime. The actual wasmer-wasix integration
/// will be added in Wave 2.
#[wasm_bindgen]
pub fn create_runtime() -> RuntimeHandle {
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    RuntimeHandle { id }
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
    fn test_create_runtime() {
        let handle = create_runtime();
        assert!(handle.id > 0);
    }

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
