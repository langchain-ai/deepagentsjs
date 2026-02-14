//! Proxy filesystem that bridges WASIX filesystem operations back to the
//! JavaScript host via wasm-bindgen callbacks.
//!
//! In Wave 2 this will implement `virtual_fs::FileSystem` for the native
//! target (used by wasmer-wasix). The wasm32 build exposes a simpler
//! callback-based interface via wasm-bindgen.
//!
//! ## Native impl plan (virtual_fs::FileSystem trait)
//!
//! Required methods to stub:
//!   - readlink(&self, path) -> Result<PathBuf>
//!   - read_dir(&self, path) -> Result<ReadDir>
//!   - create_dir(&self, path) -> Result<()>
//!   - remove_dir(&self, path) -> Result<()>
//!   - rename(&self, from, to) -> BoxFuture<Result<()>>
//!   - metadata(&self, path) -> Result<Metadata>
//!   - symlink_metadata(&self, path) -> Result<Metadata>
//!   - remove_file(&self, path) -> Result<()>
//!   - new_open_options(&self) -> OpenOptions
//!   - mount(&self, name, path, fs) -> Result<()>
//!
//! Each will proxy the call to a JS callback held in the struct.

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

/// The proxy filesystem. In the final implementation this will hold
/// JS callback references (via `wasm_bindgen::JsValue`) to forward
/// FS operations to the TypeScript `WasixBackend`.
///
/// For the native build it will implement `virtual_fs::FileSystem`.
/// For the wasm32 build it exposes methods via wasm_bindgen.
#[derive(Debug)]
pub struct ProxyFileSystem {
    _private: (),
}

impl ProxyFileSystem {
    pub fn new() -> Self {
        ProxyFileSystem { _private: () }
    }
}

impl Default for ProxyFileSystem {
    fn default() -> Self {
        Self::new()
    }
}

// ---- Native-only: virtual_fs::FileSystem implementation ----
//
// Gated behind cfg(not(wasm32)) because virtual-fs cannot compile to
// wasm32-unknown-unknown. These stubs return FsError::Unsupported.
// The real implementation will be done in Wave 2.
#[cfg(not(target_arch = "wasm32"))]
mod native_impl {
    use super::ProxyFileSystem;
    use std::path::Path;
    use virtual_fs::{FileOpener, FileSystem, FsError, Metadata, OpenOptions, ReadDir};

    impl FileSystem for ProxyFileSystem {
        fn readlink(&self, _path: &Path) -> Result<std::path::PathBuf, FsError> {
            Err(FsError::Unsupported)
        }

        fn read_dir(&self, _path: &Path) -> Result<ReadDir, FsError> {
            Err(FsError::Unsupported)
        }

        fn create_dir(&self, _path: &Path) -> Result<(), FsError> {
            Err(FsError::Unsupported)
        }

        fn remove_dir(&self, _path: &Path) -> Result<(), FsError> {
            Err(FsError::Unsupported)
        }

        fn rename<'a>(
            &'a self,
            _from: &'a Path,
            _to: &'a Path,
        ) -> futures::future::BoxFuture<'a, Result<(), FsError>> {
            Box::pin(async { Err(FsError::Unsupported) })
        }

        fn metadata(&self, _path: &Path) -> Result<Metadata, FsError> {
            Err(FsError::Unsupported)
        }

        fn symlink_metadata(&self, _path: &Path) -> Result<Metadata, FsError> {
            Err(FsError::Unsupported)
        }

        fn remove_file(&self, _path: &Path) -> Result<(), FsError> {
            Err(FsError::Unsupported)
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
            _path: &Path,
            _conf: &virtual_fs::OpenOptionsConfig,
        ) -> Result<Box<dyn virtual_fs::VirtualFile + Send + Sync>, FsError> {
            Err(FsError::Unsupported)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_proxy_fs_creates() {
        let _fs = ProxyFileSystem::new();
    }

    #[test]
    fn test_default() {
        let _fs = ProxyFileSystem::default();
    }

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
    }
}
