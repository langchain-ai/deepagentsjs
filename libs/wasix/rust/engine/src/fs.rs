//! Proxy filesystem that bridges WASIX filesystem operations back to the
//! JavaScript host via wasm-bindgen callbacks.
//!
//! ## Architecture
//!
//! - **wasm32 target**: `ProxyFileSystem` holds `js_sys::Function` references
//!   and exposes methods via `wasm_bindgen`. The `virtual_fs` crate is not
//!   compiled on this target.
//!
//! - **Native target**: `ProxyFileSystem` holds `Box<dyn Fn(...)>` closures
//!   that mirror the JS callbacks, and implements `virtual_fs::FileSystem`.
//!   This is used for testing.

use serde::{Deserialize, Serialize};

/// Metadata for a filesystem entry, mirroring the fields from
/// `virtual_fs::Metadata` that we need on the JS side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsMetadata {
    pub is_file: bool,
    pub is_dir: bool,
    pub len: u64,
}

/// Directory entry returned by readdir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub metadata: FsMetadata,
}

// ============================================================================
// wasm32 target: JS callback-based ProxyFileSystem
// ============================================================================
#[cfg(target_arch = "wasm32")]
mod wasm_impl {
    use js_sys::{Function, Reflect, Uint8Array};
    use wasm_bindgen::prelude::*;

    /// Helper to extract a `js_sys::Function` from a JS object by property name.
    fn get_callback(obj: &JsValue, name: &str) -> Result<Function, JsError> {
        let val = Reflect::get(obj, &JsValue::from_str(name))
            .map_err(|_| JsError::new(&format!("missing callback: {}", name)))?;
        val.dyn_into::<Function>()
            .map_err(|_| JsError::new(&format!("callback '{}' is not a function", name)))
    }

    /// The proxy filesystem. Holds JS callback function references to forward
    /// FS operations to the TypeScript host.
    #[wasm_bindgen]
    pub struct ProxyFileSystem {
        // Filesystem-level callbacks
        fs_read_file: Function,
        fs_write_file: Function,
        fs_metadata: Function,
        fs_read_dir: Function,
        fs_create_dir: Function,
        fs_remove_dir: Function,
        fs_remove_file: Function,
        fs_rename: Function,
        // File handle callbacks
        fs_open: Function,
        fs_handle_read: Function,
        fs_handle_write: Function,
        fs_handle_seek: Function,
        fs_handle_close: Function,
    }

    #[wasm_bindgen]
    impl ProxyFileSystem {
        /// Create a new ProxyFileSystem from a JS object containing callback functions.
        ///
        /// Expected callbacks:
        /// - `fs_read_file(path: string) -> Uint8Array | null`
        /// - `fs_write_file(path: string, contents: Uint8Array) -> boolean`
        /// - `fs_metadata(path: string) -> { is_file, is_dir, len } | null`
        /// - `fs_read_dir(path: string) -> Array<{ name, metadata: { is_file, is_dir, len } }> | null`
        /// - `fs_create_dir(path: string) -> boolean`
        /// - `fs_remove_dir(path: string) -> boolean`
        /// - `fs_remove_file(path: string) -> boolean`
        /// - `fs_rename(from: string, to: string) -> boolean`
        /// - `fs_open(path: string, flags: object) -> number` (handle ID)
        /// - `fs_handle_read(handle: number, len: number) -> Uint8Array | null`
        /// - `fs_handle_write(handle: number, data: Uint8Array) -> number`
        /// - `fs_handle_seek(handle: number, offset: number, whence: number) -> number`
        /// - `fs_handle_close(handle: number) -> void`
        #[wasm_bindgen(constructor)]
        pub fn new(callbacks: JsValue) -> Result<ProxyFileSystem, JsError> {
            Ok(ProxyFileSystem {
                fs_read_file: get_callback(&callbacks, "fs_read_file")?,
                fs_write_file: get_callback(&callbacks, "fs_write_file")?,
                fs_metadata: get_callback(&callbacks, "fs_metadata")?,
                fs_read_dir: get_callback(&callbacks, "fs_read_dir")?,
                fs_create_dir: get_callback(&callbacks, "fs_create_dir")?,
                fs_remove_dir: get_callback(&callbacks, "fs_remove_dir")?,
                fs_remove_file: get_callback(&callbacks, "fs_remove_file")?,
                fs_rename: get_callback(&callbacks, "fs_rename")?,
                fs_open: get_callback(&callbacks, "fs_open")?,
                fs_handle_read: get_callback(&callbacks, "fs_handle_read")?,
                fs_handle_write: get_callback(&callbacks, "fs_handle_write")?,
                fs_handle_seek: get_callback(&callbacks, "fs_handle_seek")?,
                fs_handle_close: get_callback(&callbacks, "fs_handle_close")?,
            })
        }

        /// Read an entire file. Returns `Uint8Array` or `null` if not found.
        pub fn read_file(&self, path: &str) -> Result<JsValue, JsError> {
            self.fs_read_file
                .call1(&JsValue::NULL, &JsValue::from_str(path))
                .map_err(|e| JsError::new(&format!("fs_read_file failed: {:?}", e)))
        }

        /// Write contents to a file. Returns `true` on success.
        pub fn write_file(&self, path: &str, contents: &[u8]) -> Result<bool, JsError> {
            let data = Uint8Array::from(contents);
            let result = self
                .fs_write_file
                .call2(&JsValue::NULL, &JsValue::from_str(path), &data)
                .map_err(|e| JsError::new(&format!("fs_write_file failed: {:?}", e)))?;
            Ok(result.as_bool().unwrap_or(false))
        }

        /// Get metadata for a path. Returns JSON-serialized `FsMetadata` or `null`.
        pub fn metadata(&self, path: &str) -> Result<JsValue, JsError> {
            self.fs_metadata
                .call1(&JsValue::NULL, &JsValue::from_str(path))
                .map_err(|e| JsError::new(&format!("fs_metadata failed: {:?}", e)))
        }

        /// Read directory entries. Returns JSON-serialized array of `DirEntry` or `null`.
        pub fn read_dir(&self, path: &str) -> Result<JsValue, JsError> {
            self.fs_read_dir
                .call1(&JsValue::NULL, &JsValue::from_str(path))
                .map_err(|e| JsError::new(&format!("fs_read_dir failed: {:?}", e)))
        }

        /// Create a directory. Returns `true` on success.
        pub fn create_dir(&self, path: &str) -> Result<bool, JsError> {
            let result = self
                .fs_create_dir
                .call1(&JsValue::NULL, &JsValue::from_str(path))
                .map_err(|e| JsError::new(&format!("fs_create_dir failed: {:?}", e)))?;
            Ok(result.as_bool().unwrap_or(false))
        }

        /// Remove a directory. Returns `true` on success.
        pub fn remove_dir(&self, path: &str) -> Result<bool, JsError> {
            let result = self
                .fs_remove_dir
                .call1(&JsValue::NULL, &JsValue::from_str(path))
                .map_err(|e| JsError::new(&format!("fs_remove_dir failed: {:?}", e)))?;
            Ok(result.as_bool().unwrap_or(false))
        }

        /// Remove a file. Returns `true` on success.
        pub fn remove_file(&self, path: &str) -> Result<bool, JsError> {
            let result = self
                .fs_remove_file
                .call1(&JsValue::NULL, &JsValue::from_str(path))
                .map_err(|e| JsError::new(&format!("fs_remove_file failed: {:?}", e)))?;
            Ok(result.as_bool().unwrap_or(false))
        }

        /// Rename/move a file or directory. Returns `true` on success.
        pub fn rename(&self, from: &str, to: &str) -> Result<bool, JsError> {
            let result = self
                .fs_rename
                .call2(
                    &JsValue::NULL,
                    &JsValue::from_str(from),
                    &JsValue::from_str(to),
                )
                .map_err(|e| JsError::new(&format!("fs_rename failed: {:?}", e)))?;
            Ok(result.as_bool().unwrap_or(false))
        }

        /// Open a file handle. Returns a numeric handle ID.
        pub fn open(
            &self,
            path: &str,
            read: bool,
            write: bool,
            create: bool,
            truncate: bool,
            append: bool,
        ) -> Result<f64, JsError> {
            let flags = js_sys::Object::new();
            Reflect::set(&flags, &"read".into(), &JsValue::from_bool(read))
                .map_err(|_| JsError::new("failed to set flags"))?;
            Reflect::set(&flags, &"write".into(), &JsValue::from_bool(write))
                .map_err(|_| JsError::new("failed to set flags"))?;
            Reflect::set(&flags, &"create".into(), &JsValue::from_bool(create))
                .map_err(|_| JsError::new("failed to set flags"))?;
            Reflect::set(&flags, &"truncate".into(), &JsValue::from_bool(truncate))
                .map_err(|_| JsError::new("failed to set flags"))?;
            Reflect::set(&flags, &"append".into(), &JsValue::from_bool(append))
                .map_err(|_| JsError::new("failed to set flags"))?;

            let result = self
                .fs_open
                .call2(&JsValue::NULL, &JsValue::from_str(path), &flags)
                .map_err(|e| JsError::new(&format!("fs_open failed: {:?}", e)))?;
            result
                .as_f64()
                .ok_or_else(|| JsError::new("fs_open did not return a number"))
        }

        /// Read from an open file handle. Returns `Uint8Array` or `null`.
        pub fn handle_read(&self, handle: f64, len: f64) -> Result<JsValue, JsError> {
            self.fs_handle_read
                .call2(
                    &JsValue::NULL,
                    &JsValue::from_f64(handle),
                    &JsValue::from_f64(len),
                )
                .map_err(|e| JsError::new(&format!("fs_handle_read failed: {:?}", e)))
        }

        /// Write to an open file handle. Returns bytes written.
        pub fn handle_write(&self, handle: f64, data: &[u8]) -> Result<f64, JsError> {
            let arr = Uint8Array::from(data);
            let result = self
                .fs_handle_write
                .call2(&JsValue::NULL, &JsValue::from_f64(handle), &arr)
                .map_err(|e| JsError::new(&format!("fs_handle_write failed: {:?}", e)))?;
            result
                .as_f64()
                .ok_or_else(|| JsError::new("fs_handle_write did not return a number"))
        }

        /// Seek within an open file handle. `whence`: 0=Start, 1=Current, 2=End.
        /// Returns the new position.
        pub fn handle_seek(&self, handle: f64, offset: f64, whence: f64) -> Result<f64, JsError> {
            let result = self
                .fs_handle_seek
                .call3(
                    &JsValue::NULL,
                    &JsValue::from_f64(handle),
                    &JsValue::from_f64(offset),
                    &JsValue::from_f64(whence),
                )
                .map_err(|e| JsError::new(&format!("fs_handle_seek failed: {:?}", e)))?;
            result
                .as_f64()
                .ok_or_else(|| JsError::new("fs_handle_seek did not return a number"))
        }

        /// Close an open file handle.
        pub fn handle_close(&self, handle: f64) -> Result<(), JsError> {
            self.fs_handle_close
                .call1(&JsValue::NULL, &JsValue::from_f64(handle))
                .map_err(|e| JsError::new(&format!("fs_handle_close failed: {:?}", e)))?;
            Ok(())
        }
    }
}

// Re-export the wasm32 ProxyFileSystem at the module level
#[cfg(target_arch = "wasm32")]
pub use wasm_impl::ProxyFileSystem;

// ============================================================================
// Native target: closure-based ProxyFileSystem + virtual_fs implementation
// ============================================================================
#[cfg(not(target_arch = "wasm32"))]
mod native_impl {
    use super::*;
    use std::io::{self, SeekFrom};
    use std::path::{Path, PathBuf};
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::{Context, Poll};
    use virtual_fs::{
        AsyncRead, AsyncSeek, AsyncWrite, FileOpener, FileSystem, FileType, FsError, Metadata,
        OpenOptions, OpenOptionsConfig, ReadBuf, ReadDir, VirtualFile,
    };

    /// Open-file flags passed to the open callback.
    #[derive(Debug, Clone)]
    pub struct OpenFlags {
        pub read: bool,
        pub write: bool,
        pub create: bool,
        pub create_new: bool,
        pub truncate: bool,
        pub append: bool,
    }

    /// Callbacks for filesystem operations. These mirror the JS callback
    /// interface, allowing native tests to supply Rust closures.
    pub struct FsCallbacks {
        pub read_file: Box<dyn Fn(&Path) -> Result<Vec<u8>, FsError> + Send + Sync>,
        pub write_file: Box<dyn Fn(&Path, &[u8]) -> Result<(), FsError> + Send + Sync>,
        pub metadata: Box<dyn Fn(&Path) -> Result<FsMetadata, FsError> + Send + Sync>,
        pub read_dir: Box<dyn Fn(&Path) -> Result<Vec<DirEntry>, FsError> + Send + Sync>,
        pub create_dir: Box<dyn Fn(&Path) -> Result<(), FsError> + Send + Sync>,
        pub remove_dir: Box<dyn Fn(&Path) -> Result<(), FsError> + Send + Sync>,
        pub remove_file: Box<dyn Fn(&Path) -> Result<(), FsError> + Send + Sync>,
        pub rename: Box<dyn Fn(&Path, &Path) -> Result<(), FsError> + Send + Sync>,
        pub open: Box<dyn Fn(&Path, &OpenFlags) -> Result<u64, FsError> + Send + Sync>,
        pub handle_read: Box<dyn Fn(u64, usize) -> Result<Vec<u8>, FsError> + Send + Sync>,
        pub handle_write: Box<dyn Fn(u64, &[u8]) -> Result<usize, FsError> + Send + Sync>,
        pub handle_seek: Box<dyn Fn(u64, SeekFrom) -> Result<u64, FsError> + Send + Sync>,
        pub handle_close: Box<dyn Fn(u64) -> Result<(), FsError> + Send + Sync>,
    }

    impl std::fmt::Debug for FsCallbacks {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("FsCallbacks").finish_non_exhaustive()
        }
    }

    /// The proxy filesystem for native builds. Holds closure-based callbacks
    /// that mirror the JS callback interface.
    #[derive(Debug)]
    pub struct ProxyFileSystem {
        callbacks: Arc<FsCallbacks>,
    }

    impl ProxyFileSystem {
        pub fn new(callbacks: FsCallbacks) -> Self {
            ProxyFileSystem {
                callbacks: Arc::new(callbacks),
            }
        }
    }

    /// Convert our `FsMetadata` to `virtual_fs::Metadata`.
    fn to_vfs_metadata(m: &FsMetadata) -> Metadata {
        Metadata {
            ft: if m.is_dir {
                FileType::new_dir()
            } else {
                FileType::new_file()
            },
            accessed: 0,
            created: 0,
            modified: 0,
            len: m.len,
        }
    }

    impl FileSystem for ProxyFileSystem {
        fn readlink(&self, _path: &Path) -> Result<PathBuf, FsError> {
            // Symlinks not supported in our proxy FS
            Err(FsError::Unsupported)
        }

        fn read_dir(&self, path: &Path) -> Result<ReadDir, FsError> {
            let entries = (self.callbacks.read_dir)(path)?;
            let vfs_entries: Vec<virtual_fs::DirEntry> = entries
                .into_iter()
                .map(|e| {
                    let entry_path = path.join(&e.name);
                    virtual_fs::DirEntry {
                        path: entry_path,
                        metadata: Ok(to_vfs_metadata(&e.metadata)),
                    }
                })
                .collect();
            Ok(ReadDir::new(vfs_entries))
        }

        fn create_dir(&self, path: &Path) -> Result<(), FsError> {
            (self.callbacks.create_dir)(path)
        }

        fn remove_dir(&self, path: &Path) -> Result<(), FsError> {
            (self.callbacks.remove_dir)(path)
        }

        fn rename<'a>(
            &'a self,
            from: &'a Path,
            to: &'a Path,
        ) -> futures::future::BoxFuture<'a, Result<(), FsError>> {
            Box::pin(async move { (self.callbacks.rename)(from, to) })
        }

        fn metadata(&self, path: &Path) -> Result<Metadata, FsError> {
            let m = (self.callbacks.metadata)(path)?;
            Ok(to_vfs_metadata(&m))
        }

        fn symlink_metadata(&self, path: &Path) -> Result<Metadata, FsError> {
            // No symlink support — just return regular metadata
            self.metadata(path)
        }

        fn remove_file(&self, path: &Path) -> Result<(), FsError> {
            (self.callbacks.remove_file)(path)
        }

        fn new_open_options(&self) -> OpenOptions<'_> {
            OpenOptions::new(self)
        }

        fn mount(
            &self,
            _name: String,
            _path: &Path,
            _fs: Box<dyn FileSystem + Send + Sync>,
        ) -> Result<(), FsError> {
            Err(FsError::Unsupported)
        }
    }

    impl FileOpener for ProxyFileSystem {
        fn open(
            &self,
            path: &Path,
            conf: &OpenOptionsConfig,
        ) -> Result<Box<dyn VirtualFile + Send + Sync>, FsError> {
            let flags = OpenFlags {
                read: conf.read(),
                write: conf.write(),
                create: conf.create(),
                create_new: conf.create_new(),
                truncate: conf.truncate(),
                append: conf.append(),
            };
            let handle = (self.callbacks.open)(path, &flags)?;
            Ok(Box::new(ProxyFile {
                handle,
                callbacks: Arc::clone(&self.callbacks),
            }))
        }
    }

    // ---- ProxyFile: VirtualFile implementation for open file handles ----

    /// An open file handle backed by callbacks.
    #[derive(Debug)]
    struct ProxyFile {
        handle: u64,
        callbacks: Arc<FsCallbacks>,
    }

    impl Drop for ProxyFile {
        fn drop(&mut self) {
            let _ = (self.callbacks.handle_close)(self.handle);
        }
    }

    impl VirtualFile for ProxyFile {
        fn last_accessed(&self) -> u64 {
            0
        }

        fn last_modified(&self) -> u64 {
            0
        }

        fn created_time(&self) -> u64 {
            0
        }

        fn size(&self) -> u64 {
            0
        }

        fn set_len(&mut self, _new_size: u64) -> virtual_fs::Result<()> {
            Err(FsError::Unsupported)
        }

        fn unlink(&mut self) -> virtual_fs::Result<()> {
            Err(FsError::Unsupported)
        }

        fn poll_read_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Ok(0))
        }

        fn poll_write_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Ok(0))
        }
    }

    impl AsyncRead for ProxyFile {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            let len = buf.remaining();
            match (this.callbacks.handle_read)(this.handle, len) {
                Ok(data) => {
                    buf.put_slice(&data);
                    Poll::Ready(Ok(()))
                }
                Err(e) => Poll::Ready(Err(io::Error::new(io::ErrorKind::Other, e.to_string()))),
            }
        }
    }

    impl AsyncWrite for ProxyFile {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            let this = self.get_mut();
            match (this.callbacks.handle_write)(this.handle, buf) {
                Ok(n) => Poll::Ready(Ok(n)),
                Err(e) => Poll::Ready(Err(io::Error::new(io::ErrorKind::Other, e.to_string()))),
            }
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    impl AsyncSeek for ProxyFile {
        fn start_seek(self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
            let this = self.get_mut();
            match (this.callbacks.handle_seek)(this.handle, position) {
                Ok(_) => Ok(()),
                Err(e) => Err(io::Error::new(io::ErrorKind::Other, e.to_string())),
            }
        }

        fn poll_complete(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<io::Result<u64>> {
            // Since our seek is synchronous, it's already complete.
            // Return 0 as the position — the actual position was set in start_seek.
            Poll::Ready(Ok(0))
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native_impl::{FsCallbacks, OpenFlags, ProxyFileSystem};

// ============================================================================
// Tests (native only — requires virtual_fs)
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fs_metadata_serde() {
        let meta = FsMetadata {
            is_file: true,
            is_dir: false,
            len: 42,
        };
        let json = serde_json::to_string(&meta).unwrap();
        let deserialized: FsMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.len, 42);
        assert!(deserialized.is_file);
        assert!(!deserialized.is_dir);
    }

    #[test]
    fn test_dir_entry_serde() {
        let entry = DirEntry {
            name: "hello.txt".to_string(),
            metadata: FsMetadata {
                is_file: true,
                is_dir: false,
                len: 100,
            },
        };
        let json = serde_json::to_string(&entry).unwrap();
        let deserialized: DirEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "hello.txt");
    }

    #[cfg(not(target_arch = "wasm32"))]
    mod native_tests {
        use super::*;
        use std::collections::HashMap;
        use std::io::SeekFrom;
        use std::path::{Path, PathBuf};
        use std::sync::{Arc, Mutex};
        use virtual_fs::{FileSystem, FsError};

        /// Build a ProxyFileSystem with an in-memory store for testing.
        fn make_test_fs() -> (ProxyFileSystem, Arc<Mutex<HashMap<PathBuf, Vec<u8>>>>) {
            let store: Arc<Mutex<HashMap<PathBuf, Vec<u8>>>> =
                Arc::new(Mutex::new(HashMap::new()));

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
                move |_path: &Path| -> Result<Vec<DirEntry>, FsError> { Ok(vec![]) };

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

            // Handle-based operations backed by the same store
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
                // Write through to store
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

            (ProxyFileSystem::new(callbacks), store)
        }

        #[test]
        fn test_proxy_fs_metadata() {
            let (fs, store) = make_test_fs();
            store
                .lock()
                .unwrap()
                .insert(PathBuf::from("/test.txt"), b"hello".to_vec());

            let meta = fs.metadata(Path::new("/test.txt")).unwrap();
            assert!(meta.is_file());
            assert!(!meta.is_dir());
            assert_eq!(meta.len(), 5);
        }

        #[test]
        fn test_proxy_fs_metadata_not_found() {
            let (fs, _store) = make_test_fs();
            let result = fs.metadata(Path::new("/nope"));
            assert!(result.is_err());
        }

        #[test]
        fn test_proxy_fs_read_dir() {
            let (fs, _store) = make_test_fs();
            let entries = fs.read_dir(Path::new("/")).unwrap();
            assert_eq!(entries.count(), 0);
        }

        #[test]
        fn test_proxy_fs_create_dir() {
            let (fs, _store) = make_test_fs();
            let result = fs.create_dir(Path::new("/mydir"));
            assert!(result.is_ok());
        }

        #[test]
        fn test_proxy_fs_remove_file() {
            let (fs, store) = make_test_fs();
            store
                .lock()
                .unwrap()
                .insert(PathBuf::from("/test.txt"), b"data".to_vec());

            assert!(fs.remove_file(Path::new("/test.txt")).is_ok());
            assert!(fs.metadata(Path::new("/test.txt")).is_err());
        }

        #[test]
        fn test_proxy_fs_rename() {
            let (fs, store) = make_test_fs();
            store
                .lock()
                .unwrap()
                .insert(PathBuf::from("/a.txt"), b"data".to_vec());

            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            rt.block_on(async {
                fs.rename(Path::new("/a.txt"), Path::new("/b.txt")).await.unwrap();
            });

            let s = store.lock().unwrap();
            assert!(!s.contains_key(&PathBuf::from("/a.txt")));
            assert!(s.contains_key(&PathBuf::from("/b.txt")));
        }

        #[test]
        fn test_proxy_file_open_and_read() {
            let (fs, store) = make_test_fs();
            store
                .lock()
                .unwrap()
                .insert(PathBuf::from("/hello.txt"), b"hello world".to_vec());

            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            rt.block_on(async {
                use tokio::io::AsyncReadExt;

                let mut file = fs
                    .new_open_options()
                    .read(true)
                    .open("/hello.txt")
                    .unwrap();

                let mut buf = vec![0u8; 5];
                let n = file.read(&mut buf).await.unwrap();
                assert_eq!(n, 5);
                assert_eq!(&buf[..n], b"hello");
            });
        }

        #[test]
        fn test_proxy_file_write() {
            let (fs, store) = make_test_fs();
            store
                .lock()
                .unwrap()
                .insert(PathBuf::from("/out.txt"), vec![]);

            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            rt.block_on(async {
                use tokio::io::AsyncWriteExt;

                let mut file = fs
                    .new_open_options()
                    .write(true)
                    .open("/out.txt")
                    .unwrap();

                file.write_all(b"test data").await.unwrap();
            });

            let s = store.lock().unwrap();
            assert_eq!(s.get(&PathBuf::from("/out.txt")).unwrap(), b"test data");
        }
    }
}
