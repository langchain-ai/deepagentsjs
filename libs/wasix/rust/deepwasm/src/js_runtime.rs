use std::{
    ops::{Deref, DerefMut},
    sync::Arc,
};

use wasm_bindgen::{prelude::wasm_bindgen, JsCast};

use crate::{runtime::Runtime, utils::Error};

#[derive(Clone, Debug, wasm_bindgen_derive::TryFromJsValue)]
#[repr(transparent)]
#[wasm_bindgen(js_name = "Runtime")]
pub struct JsRuntime {
    // Note: This is just a wrapper around the "real" runtime implementation.
    // We need it because most JS-facing methods will want to accept/return an
    // `Arc<Runtime>`, but wasm-bindgen doesn't support passing Arc around
    // directly.
    rt: Arc<Runtime>,
}

impl JsRuntime {
    pub fn new(rt: Arc<Runtime>) -> Self {
        JsRuntime { rt }
    }

    pub fn into_inner(self) -> Arc<Runtime> {
        self.rt
    }
}

#[wasm_bindgen(js_class = "Runtime")]
impl JsRuntime {
    #[wasm_bindgen(constructor)]
    pub fn js_new(options: Option<RuntimeOptions>) -> Result<JsRuntime, Error> {
        let registry = match options.as_ref().and_then(|opts| opts.registry()) {
            Some(registry_url) => registry_url.resolve(),
            None => Some(crate::DEFAULT_REGISTRY.to_string()),
        };

        let mut rt = Runtime::new();

        if let Some(registry) = registry.as_deref() {
            let api_key = options.as_ref().and_then(|opts| opts.api_key());
            rt.set_registry(registry, api_key.as_deref())?;
        }

        if let Some(gateway) = options.as_ref().and_then(|opts| opts.network_gateway()) {
            rt.set_network_gateway(gateway);
        }

        Ok(JsRuntime::new(Arc::new(rt)))
    }

    /// Get a reference to the global runtime, optionally initializing it if
    /// requested.
    pub fn global(initialize: Option<bool>) -> Result<Option<JsRuntime>, Error> {
        match Runtime::global() {
            Some(rt) => Ok(Some(JsRuntime { rt })),
            None if initialize == Some(true) => {
                let rt = Runtime::lazily_initialized()?;
                Ok(Some(JsRuntime { rt }))
            }
            None => Ok(None),
        }
    }
}

impl Deref for JsRuntime {
    type Target = Arc<Runtime>;

    fn deref(&self) -> &Self::Target {
        &self.rt
    }
}

impl DerefMut for JsRuntime {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.rt
    }
}

impl From<Arc<Runtime>> for JsRuntime {
    fn from(value: Arc<Runtime>) -> Self {
        JsRuntime::new(value)
    }
}

impl AsRef<Arc<Runtime>> for JsRuntime {
    fn as_ref(&self) -> &Arc<Runtime> {
        self
    }
}

#[wasm_bindgen(typescript_custom_section)]
const RUNTIME_OPTIONS_TYPE_DECLARATION: &str = r#"
/**
 * Options used when constructing a {@link Runtime}.
 */
export type RuntimeOptions = {
    /**
     * The GraphQL endpoint for the Wasmer registry used when looking up
     * packages.
     *
     * Defaults to `"https://registry.wasmer.io/graphql"`.
     *
     * If `null`, no queries will be made to the registry.
     */
    registry?: string | null;
    /**
     * An optional API key to use when sending requests to the Wasmer registry.
     */
    apiKey?: string;
    /**
     * Enable networking (i.e. TCP and UDP) via a gateway server.
     */
    networkGateway?: string;
};
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "RuntimeOptions")]
    pub type RuntimeOptions;

    #[wasm_bindgen(method, getter)]
    fn registry(this: &RuntimeOptions) -> Option<MaybeRegistryUrl>;

    #[wasm_bindgen(method, getter, js_name = "apiKey")]
    fn api_key(this: &RuntimeOptions) -> Option<String>;

    #[wasm_bindgen(method, getter, js_name = "networkGateway")]
    fn network_gateway(this: &RuntimeOptions) -> Option<String>;

    #[wasm_bindgen(typescript_type = "string | null | undefined")]
    type MaybeRegistryUrl;
}

impl MaybeRegistryUrl {
    fn resolve(&self) -> Option<String> {
        if self.is_undefined() {
            Some(crate::DEFAULT_REGISTRY.to_string())
        } else if self.is_null() {
            None
        } else if let Some(s) = self.dyn_ref::<js_sys::JsString>() {
            Some(s.into())
        } else {
            unreachable!()
        }
    }
}
