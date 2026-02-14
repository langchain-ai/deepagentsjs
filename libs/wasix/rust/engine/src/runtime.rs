//! Native WASIX runtime — loads and executes WASM binaries with our ProxyFileSystem.
//!
//! This module is **native-only** (`cfg(not(target_arch = "wasm32"))`).
//! On the wasm32 target, execution is delegated to `@wasmer/sdk` on the JS side.

use std::sync::Arc;

use virtual_fs::AsyncReadExt;
use wasmer::{Engine, Module};
use wasmer_wasix::{
    runners::wasi::{RuntimeOrEngine, WasiRunner},
    Pipe,
};

use crate::fs::ProxyFileSystem;
use crate::ExecuteResult;

/// Execute a command by running it as a WASI binary with our ProxyFileSystem mounted.
///
/// `wasm_bytes` is the raw .wasm binary to execute (e.g. a bash or coreutils build).
/// `args` are passed as command-line arguments to the WASM program.
/// `fs` is the ProxyFileSystem that will be mounted at `/` inside the WASI environment.
///
/// Returns an `ExecuteResult` with captured stdout, stderr, and exit code.
pub fn execute_wasm(
    wasm_bytes: &[u8],
    program_name: &str,
    args: &[&str],
    fs: Arc<ProxyFileSystem>,
) -> ExecuteResult {
    // Build a multi-threaded tokio runtime — wasmer-wasix needs this for async internals.
    let tokio_runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to create tokio runtime");
    let _guard = tokio_runtime.enter();

    let engine = Engine::default();
    let module = match Module::new(&engine, wasm_bytes) {
        Ok(m) => m,
        Err(e) => {
            return ExecuteResult {
                output: format!("Failed to compile WASM module: {}\n", e),
                exit_code: 1,
                truncated: false,
            };
        }
    };

    // Create pipes to capture stdout and stderr.
    let (stdout_tx, mut stdout_rx) = Pipe::channel();
    let (stderr_tx, mut stderr_rx) = Pipe::channel();

    let run_result = {
        let mut runner = WasiRunner::new();
        runner
            .with_stdout(Box::new(stdout_tx))
            .with_stderr(Box::new(stderr_tx))
            .with_args(args.iter().map(|s| s.to_string()))
            .with_mount("/app".to_string(), fs);

        runner.run_wasm(
            RuntimeOrEngine::Engine(engine),
            program_name,
            module,
            wasmer_types::ModuleHash::random(),
        )
    };

    // Read captured output.
    let mut stdout_str = String::new();
    let mut stderr_str = String::new();
    virtual_mio::block_on(stdout_rx.read_to_string(&mut stdout_str)).ok();
    virtual_mio::block_on(stderr_rx.read_to_string(&mut stderr_str)).ok();

    // Combine stdout and stderr (stderr appended after stdout).
    let mut output = stdout_str;
    if !stderr_str.is_empty() {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&stderr_str);
    }

    let exit_code = match run_result {
        Ok(()) => 0,
        Err(e) => {
            // Try to extract an exit code from the error message.
            let err_msg = format!("{}", e);
            if output.is_empty() {
                output = err_msg;
            }
            1
        }
    };

    ExecuteResult {
        output,
        exit_code,
        truncated: false,
    }
}

/// Execute a command using a WAT (WebAssembly Text) program.
/// Convenience wrapper for testing — compiles WAT to WASM, then runs it.
pub fn execute_wat(
    wat_source: &[u8],
    program_name: &str,
    args: &[&str],
    fs: Arc<ProxyFileSystem>,
) -> ExecuteResult {
    execute_wasm(wat_source, program_name, args, fs)
}

/// Convenience: run a simple WASI program that writes to stdout.
/// This is the "native execute" entry point — the equivalent of what `@wasmer/sdk`
/// does on the JS side.
pub fn native_execute(
    command: &str,
    fs: Option<Arc<ProxyFileSystem>>,
) -> ExecuteResult {
    // For now, we need a WASM binary to run. Without a pre-built bash binary,
    // we can only run raw WASM/WAT. This function serves as the integration point
    // that will eventually load bash from the Wasmer registry.
    //
    // Current behavior: return an error indicating that a WASM binary is needed.
    // The real implementation will:
    // 1. Check a cache for the bash WASIX binary
    // 2. Download it from the Wasmer registry if not cached
    // 3. Run: bash -c "<command>" with the ProxyFileSystem mounted
    let _ = fs;
    ExecuteResult {
        output: format!(
            "native_execute: WASM binary not yet configured for command: {}\n\
             Use execute_wasm() directly with a pre-compiled WASM binary.\n",
            command
        ),
        exit_code: 1,
        truncated: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::{FsCallbacks, FsMetadata, OpenFlags};
    use std::collections::HashMap;
    use std::io::SeekFrom;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use virtual_fs::FsError;

    /// Build a ProxyFileSystem backed by an in-memory HashMap.
    fn make_test_fs() -> (Arc<ProxyFileSystem>, Arc<Mutex<HashMap<PathBuf, Vec<u8>>>>) {
        let store: Arc<Mutex<HashMap<PathBuf, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));

        let s = Arc::clone(&store);
        let read_file = move |path: &Path| -> Result<Vec<u8>, FsError> {
            let store = s.lock().unwrap();
            store
                .get(&path.to_path_buf())
                .cloned()
                .ok_or(FsError::EntryNotFound)
        };

        let s = Arc::clone(&store);
        let write_file = move |path: &Path, data: &[u8]| -> Result<(), FsError> {
            let mut store = s.lock().unwrap();
            store.insert(path.to_path_buf(), data.to_vec());
            Ok(())
        };

        let s = Arc::clone(&store);
        let metadata_cb = move |path: &Path| -> Result<FsMetadata, FsError> {
            let store = s.lock().unwrap();
            if store.contains_key(&path.to_path_buf()) {
                let len = store[&path.to_path_buf()].len() as u64;
                Ok(FsMetadata {
                    is_file: true,
                    is_dir: false,
                    len,
                })
            } else {
                Err(FsError::EntryNotFound)
            }
        };

        let read_dir_cb =
            move |_path: &Path| -> Result<Vec<crate::DirEntry>, FsError> { Ok(vec![]) };
        let create_dir_cb = move |_path: &Path| -> Result<(), FsError> { Ok(()) };
        let remove_dir_cb = move |_path: &Path| -> Result<(), FsError> { Ok(()) };

        let s2 = Arc::clone(&store);
        let remove_file_cb = move |path: &Path| -> Result<(), FsError> {
            let mut store = s2.lock().unwrap();
            store
                .remove(&path.to_path_buf())
                .map(|_| ())
                .ok_or(FsError::EntryNotFound)
        };

        let s3 = Arc::clone(&store);
        let rename_cb = move |from: &Path, to: &Path| -> Result<(), FsError> {
            let mut store = s3.lock().unwrap();
            if let Some(data) = store.remove(&from.to_path_buf()) {
                store.insert(to.to_path_buf(), data);
                Ok(())
            } else {
                Err(FsError::EntryNotFound)
            }
        };

        let handles: Arc<Mutex<HashMap<u64, (PathBuf, Vec<u8>, u64)>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let next_handle: Arc<std::sync::atomic::AtomicU64> =
            Arc::new(std::sync::atomic::AtomicU64::new(1));

        let h = Arc::clone(&handles);
        let nh = Arc::clone(&next_handle);
        let s5 = Arc::clone(&store);
        let open_cb = move |path: &Path, _flags: &OpenFlags| -> Result<u64, FsError> {
            let store = s5.lock().unwrap();
            let data = store
                .get(&path.to_path_buf())
                .cloned()
                .unwrap_or_default();
            let id = nh.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let mut h = h.lock().unwrap();
            h.insert(id, (path.to_path_buf(), data, 0));
            Ok(id)
        };

        let h2 = Arc::clone(&handles);
        let handle_read_cb = move |handle: u64, len: usize| -> Result<Vec<u8>, FsError> {
            let mut h = h2.lock().unwrap();
            let (_, data, pos) = h.get_mut(&handle).ok_or(FsError::InvalidFd)?;
            let start = *pos as usize;
            let end = std::cmp::min(start + len, data.len());
            let result = data[start..end].to_vec();
            *pos = end as u64;
            Ok(result)
        };

        let h3 = Arc::clone(&handles);
        let s6 = Arc::clone(&store);
        let handle_write_cb = move |handle: u64, buf: &[u8]| -> Result<usize, FsError> {
            let mut h = h3.lock().unwrap();
            let (path, data, pos) = h.get_mut(&handle).ok_or(FsError::InvalidFd)?;
            let start = *pos as usize;
            if start + buf.len() > data.len() {
                data.resize(start + buf.len(), 0);
            }
            data[start..start + buf.len()].copy_from_slice(buf);
            *pos += buf.len() as u64;
            let mut store = s6.lock().unwrap();
            store.insert(path.clone(), data.clone());
            Ok(buf.len())
        };

        let h4 = Arc::clone(&handles);
        let handle_seek_cb = move |handle: u64, seek: SeekFrom| -> Result<u64, FsError> {
            let mut h = h4.lock().unwrap();
            let (_, data, pos) = h.get_mut(&handle).ok_or(FsError::InvalidFd)?;
            let new_pos = match seek {
                SeekFrom::Start(p) => p,
                SeekFrom::End(offset) => (data.len() as i64 + offset) as u64,
                SeekFrom::Current(offset) => (*pos as i64 + offset) as u64,
            };
            *pos = new_pos;
            Ok(new_pos)
        };

        let h5 = Arc::clone(&handles);
        let handle_close_cb = move |handle: u64| -> Result<(), FsError> {
            let mut h = h5.lock().unwrap();
            h.remove(&handle);
            Ok(())
        };

        let callbacks = FsCallbacks {
            read_file: Box::new(read_file),
            write_file: Box::new(write_file),
            metadata: Box::new(metadata_cb),
            read_dir: Box::new(read_dir_cb),
            create_dir: Box::new(create_dir_cb),
            remove_dir: Box::new(remove_dir_cb),
            remove_file: Box::new(remove_file_cb),
            rename: Box::new(rename_cb),
            open: Box::new(open_cb),
            handle_read: Box::new(handle_read_cb),
            handle_write: Box::new(handle_write_cb),
            handle_seek: Box::new(handle_seek_cb),
            handle_close: Box::new(handle_close_cb),
        };

        (Arc::new(ProxyFileSystem::new(callbacks)), store)
    }

    /// A minimal WASI program (in WAT) that writes "hello world" to stdout.
    const HELLO_WORLD_WAT: &[u8] = br#"
    (module
        ;; Import fd_write from WASI
        (import "wasi_unstable" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))

        (memory 1)
        (export "memory" (memory 0))

        ;; "hello world" at offset 8
        (data (i32.const 8) "hello world\n")

        (func $main (export "_start")
            ;; iov_base = 8, iov_len = 12
            (i32.store (i32.const 0) (i32.const 8))
            (i32.store (i32.const 4) (i32.const 12))

            (call $fd_write
                (i32.const 1) ;; stdout
                (i32.const 0) ;; *iovs
                (i32.const 1) ;; iovs_len
                (i32.const 20) ;; nwritten
            )
            drop
        )
    )
    "#;

    #[test]
    fn test_execute_wat_hello_world() {
        let (fs, _store) = make_test_fs();
        let result = execute_wasm(HELLO_WORLD_WAT, "hello", &[], fs);
        assert_eq!(result.exit_code, 0, "exit_code should be 0, got output: {}", result.output);
        assert_eq!(result.output, "hello world\n");
        assert!(!result.truncated);
    }

    #[test]
    fn test_execute_with_args() {
        // The hello world WAT ignores args, but we verify args don't break execution.
        let (fs, _store) = make_test_fs();
        let result = execute_wasm(HELLO_WORLD_WAT, "hello", &["arg1", "arg2"], fs);
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.output, "hello world\n");
    }

    #[test]
    fn test_execute_invalid_wasm() {
        let (fs, _store) = make_test_fs();
        let result = execute_wasm(b"not a wasm module", "bad", &[], fs);
        assert_eq!(result.exit_code, 1);
        assert!(result.output.contains("Failed to compile WASM module"));
    }

    #[test]
    fn test_native_execute_stub() {
        let result = native_execute("echo hello", None);
        assert_eq!(result.exit_code, 1);
        assert!(result.output.contains("WASM binary not yet configured"));
    }
}
