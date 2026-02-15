use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc, Mutex, Weak};

use lazy_static::lazy_static;
use once_cell::sync::Lazy;
use virtual_net::VirtualNetworking;
use wasmer_wasix::{
    http::{HttpClient, WebHttpClient as DefaultHttpClient}, // reqwest::ReqwestHttpClient
    os::{TtyBridge, TtyOptions},
    runtime::{
        module_cache::ThreadLocalCache,
        package_loader::PackageLoader,
        resolver::InMemorySource,
    },
    VirtualTaskManager,
    WasiTtyState,
};
use webc::Container;

lazy_static! {
    /// We initialize the ThreadPool lazily
    static ref DEFAULT_THREAD_POOL: Arc<ThreadPool> = Arc::new(ThreadPool::new());
}

use crate::{tasks::ThreadPool, utils::Error};

/// Global InMemorySource for offline package resolution.
pub(crate) static GLOBAL_SOURCE: Lazy<Mutex<InMemorySource>> =
    Lazy::new(|| Mutex::new(InMemorySource::new()));

/// Global store for .webc containers keyed by their fake file:// URL.
/// The PackageLoader checks this before attempting an HTTP download.
pub(crate) static GLOBAL_CONTAINERS: Lazy<Mutex<HashMap<url::Url, Container>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// A weak reference to the global [`Runtime`].
static GLOBAL_RUNTIME: Lazy<Mutex<Weak<Runtime>>> = Lazy::new(Mutex::default);

/// Runtime components used when running WebAssembly programs.
#[derive(Clone, derivative::Derivative)]
#[derivative(Debug)]
pub struct Runtime {
    task_manager: Option<Arc<dyn VirtualTaskManager>>,
    networking: Arc<dyn VirtualNetworking>,
    http_client: Arc<dyn HttpClient + Send + Sync>,
    package_loader: Arc<crate::package_loader::PackageLoader>,
    module_cache: Arc<ThreadLocalCache>,
    tty: TtyOptions,
    connected_to_tty: Arc<AtomicBool>,
}

impl Runtime {
    /// Get a reference to the global runtime, if it has already been
    /// initialized.
    pub(crate) fn global() -> Option<Arc<Runtime>> {
        GLOBAL_RUNTIME.lock().ok()?.upgrade()
    }

    /// Get a reference to the global runtime, initializing it if it hasn't
    /// already been.
    pub(crate) fn lazily_initialized() -> Result<Arc<Self>, Error> {
        match GLOBAL_RUNTIME.lock() {
            Ok(mut guard) => match guard.upgrade() {
                Some(rt) => Ok(rt),
                None => {
                    tracing::debug!("Initializing the global runtime");
                    let rt = Arc::new(Runtime::with_defaults()?);
                    *guard = Arc::downgrade(&rt);

                    Ok(rt)
                }
            },
            Err(mut e) => {
                tracing::warn!("The global runtime lock was poisoned. Reinitializing.");

                let rt = Arc::new(Runtime::with_defaults()?);
                **e.get_mut() = Arc::downgrade(&rt);

                // FIXME: Use this when it becomes stable
                // GLOBAL_RUNTIME.clear_poison();

                Ok(rt)
            }
        }
    }

    pub(crate) fn with_defaults() -> Result<Self, Error> {
        Ok(Runtime::new())
    }

    pub(crate) fn with_task_manager(&self, task_manager: Arc<ThreadPool>) -> Self {
        let mut runtime = self.clone();
        // Update the http client
        let http_client = DefaultHttpClient::default();
        // http_client
        //     .with_default_header(
        //         reqwest::header::USER_AGENT,
        //         HeaderValue::from_static(crate::USER_AGENT),
        //     )
        //     .with_task_manager(task_manager.clone());
        runtime.http_client = Arc::new(http_client);

        runtime.task_manager = Some(task_manager);
        runtime
    }

    pub(crate) fn with_default_pool(&self) -> Self {
        // let pool = ThreadPool::new();
        self.with_task_manager(DEFAULT_THREAD_POOL.clone())
    }

    pub(crate) fn new() -> Self {
        let http_client = Arc::new(DefaultHttpClient::default());

        let module_cache = ThreadLocalCache::default();
        let package_loader = crate::package_loader::PackageLoader::new(http_client.clone());

        Runtime {
            task_manager: None,
            networking: Arc::new(virtual_net::UnsupportedVirtualNetworking::default()),
            http_client: Arc::new(http_client),
            package_loader: Arc::new(package_loader),
            module_cache: Arc::new(module_cache),
            tty: TtyOptions::default(),
            connected_to_tty: Arc::new(AtomicBool::new(false)),
        }
    }

}

impl Runtime {
    pub(crate) fn tty_options(&self) -> &TtyOptions {
        &self.tty
    }

    pub(crate) fn set_connected_to_tty(&self, state: bool) {
        self.connected_to_tty
            .store(state, std::sync::atomic::Ordering::SeqCst);
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        tracing::debug!("Dropping Runtime");
    }
}

impl wasmer_wasix::runtime::Runtime for Runtime {
    fn networking(&self) -> &Arc<dyn VirtualNetworking> {
        &self.networking
    }

    fn task_manager(&self) -> &Arc<dyn VirtualTaskManager> {
        self.task_manager.as_ref().expect("Task manager not found")
    }

    fn source(&self) -> Arc<dyn wasmer_wasix::runtime::resolver::Source + Send + Sync> {
        let source = GLOBAL_SOURCE.lock().unwrap().clone();
        Arc::new(source)
    }

    fn http_client(&self) -> Option<&wasmer_wasix::http::DynHttpClient> {
        None
    }

    fn package_loader(&self) -> Arc<dyn PackageLoader + Send + Sync> {
        self.package_loader.clone()
    }

    fn module_cache(
        &self,
    ) -> Arc<dyn wasmer_wasix::runtime::module_cache::ModuleCache + Send + Sync> {
        self.module_cache.clone()
    }

    fn load_module_sync(&self, wasm: &[u8]) -> Result<wasmer::Module, wasmer_wasix::SpawnError> {
        let wasm = unsafe { js_sys::Uint8Array::view(wasm) };
        let module = js_sys::WebAssembly::Module::new(&wasm)
            .map_err(|x| wasmer_wasix::SpawnError::Other(crate::utils::js_error(x).into()))?;

        Ok(wasmer::Module::from((module, wasm.to_vec())))
    }

    fn tty(&self) -> Option<&(dyn wasmer_wasix::os::TtyBridge + Send + Sync)> {
        Some(self)
    }
}

impl TtyBridge for Runtime {
    #[tracing::instrument(level = "debug", skip_all)]
    fn reset(&self) {
        self.tty.set_echo(true);
        self.tty.set_line_buffering(true);
        self.tty.set_line_feeds(true);
        self.set_connected_to_tty(false);
    }

    #[tracing::instrument(level = "debug", skip(self), ret)]
    fn tty_get(&self) -> WasiTtyState {
        let connected_to_tty = self
            .connected_to_tty
            .load(std::sync::atomic::Ordering::SeqCst);

        WasiTtyState {
            cols: self.tty.cols(),
            rows: self.tty.rows(),
            width: 800,
            height: 600,
            stdin_tty: connected_to_tty,
            stdout_tty: connected_to_tty,
            stderr_tty: connected_to_tty,
            echo: self.tty.echo(),
            line_buffered: self.tty.line_buffering(),
            line_feeds: self.tty.line_feeds(),
        }
    }

    #[tracing::instrument(level = "debug", skip(self))]
    fn tty_set(&self, tty_state: WasiTtyState) {
        self.tty.set_cols(tty_state.cols);
        self.tty.set_rows(tty_state.rows);
        self.tty.set_echo(tty_state.echo);
        self.tty.set_line_buffering(tty_state.line_buffered);
        self.tty.set_line_feeds(tty_state.line_feeds);
        self.set_connected_to_tty(
            tty_state.stdin_tty || tty_state.stdout_tty || tty_state.stderr_tty,
        );
    }
}

#[cfg(test)]
mod tests {
    use wasm_bindgen_test::wasm_bindgen_test;
    use wasmer::Module;
    use wasmer_wasix::{Runtime as _, WasiEnvBuilder};

    use super::*;

    pub(crate) const TRIVIAL_WAT: &[u8] = br#"(
        module
            (memory $memory 0)
            (export "memory" (memory $memory))
            (func (export "_start") nop)
        )"#;

    #[wasm_bindgen_test]
    async fn execute_a_trivial_module() {
        let runtime = Runtime::with_defaults().unwrap().with_default_pool();
        // let module = runtime.load_module(TRIVIAL_WAT).await.unwrap();

        let module = Module::new(&runtime.engine(), TRIVIAL_WAT).unwrap();

        WasiEnvBuilder::new("trivial")
            .runtime(Arc::new(runtime))
            .run(module)
            .unwrap();
    }
}
