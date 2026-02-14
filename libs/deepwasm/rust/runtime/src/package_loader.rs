// Package loader that downloads .webc dependency packages from the Wasmer registry.
// The `load()` method fetches a single dependency webc by URL (e.g. wasmer/coreutils).
// The `load_package_tree()` method delegates to the library's free function which
// orchestrates resolution of the full dependency graph.

use std::sync::Arc;

use anyhow::{Context, Error};
use http::Method;
use wasmer_wasix::{
    bin_factory::BinaryPackage,
    http::{HttpClient, HttpRequest, HttpRequestOptions},
    runtime::resolver::{PackageSummary, Resolution},
};
use webc::Container;

/// Package loader that can download dependency .webc files via HTTP.
#[derive(Debug, Clone)]
pub struct PackageLoader {
    client: Arc<dyn HttpClient + Send + Sync>,
}

impl PackageLoader {
    pub fn new(client: Arc<dyn HttpClient + Send + Sync>) -> Self {
        PackageLoader { client }
    }
}

#[async_trait::async_trait]
impl wasmer_wasix::runtime::package_loader::PackageLoader for PackageLoader {
    async fn load(&self, summary: &PackageSummary) -> Result<Container, Error> {
        let url = &summary.dist.webc;

        // Check the global container store first (for locally registered packages)
        if let Some(container) = crate::runtime::GLOBAL_CONTAINERS
            .lock()
            .unwrap()
            .get(url)
            .cloned()
        {
            tracing::debug!(%url, pkg=%summary.pkg.id, "Loading dependency from local store");
            return Ok(container);
        }

        tracing::debug!(%url, pkg=%summary.pkg.id, "Downloading dependency webc");

        let request = HttpRequest {
            url: url.clone(),
            method: Method::GET,
            headers: Default::default(),
            body: None,
            options: HttpRequestOptions::default(),
        };

        let response = self
            .client
            .request(request)
            .await
            .with_context(|| format!("Failed to download webc from {url}"))?;

        if !response.is_ok() {
            anyhow::bail!(
                "HTTP {} downloading webc from {url}",
                response.status,
            );
        }

        let body: bytes::Bytes = response
            .body
            .context("Empty response body when downloading webc")?
            .into();

        let version = webc::detect(&mut body.as_ref())?;
        let container = Container::from_bytes_and_version(body, version)?;

        Ok(container)
    }

    async fn load_package_tree(
        &self,
        root: &Container,
        resolution: &Resolution,
        root_is_local_dir: bool,
    ) -> Result<BinaryPackage, Error> {
        wasmer_wasix::runtime::package_loader::load_package_tree(
            root,
            self,
            resolution,
            root_is_local_dir,
        )
        .await
    }
}
