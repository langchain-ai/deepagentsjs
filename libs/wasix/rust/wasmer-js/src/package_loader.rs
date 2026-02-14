// Removed: Package loader that downloads .webc files from the Wasmer registry.
// We load WASM modules directly rather than through the package registry.
// Original implementation used HttpClient to fetch and cache webc containers.
//
// Stub retained because runtime.rs references PackageLoader for the
// wasmer_wasix::runtime::Runtime trait implementation.

use std::sync::Arc;

use anyhow::Error;
use wasmer_wasix::{
    bin_factory::BinaryPackage,
    http::HttpClient,
    runtime::resolver::{PackageSummary, Resolution},
};
use webc::Container;

/// A stub package loader. Downloads are not supported in this fork.
#[derive(Debug, Clone)]
pub struct PackageLoader {
    _client: Arc<dyn HttpClient + Send + Sync>,
}

impl PackageLoader {
    pub fn new(client: Arc<dyn HttpClient + Send + Sync>) -> Self {
        PackageLoader { _client: client }
    }
}

#[async_trait::async_trait]
impl wasmer_wasix::runtime::package_loader::PackageLoader for PackageLoader {
    async fn load(&self, _summary: &PackageSummary) -> Result<Container, Error> {
        Err(anyhow::anyhow!(
            "Package loading from registry is not supported in this build"
        ))
    }

    async fn load_package_tree(
        &self,
        _root: &Container,
        _resolution: &Resolution,
        _root_is_local_dir: bool,
    ) -> Result<BinaryPackage, Error> {
        Err(anyhow::anyhow!(
            "Package tree loading is not supported in this build"
        ))
    }
}
