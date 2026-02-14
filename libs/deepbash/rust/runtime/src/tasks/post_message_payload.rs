use derivative::Derivative;
use js_sys::WebAssembly;
use wasm_bindgen::JsValue;
use wasmer_types::ModuleHash;

use crate::tasks::{
    interop::Serializer, task_wasm::SpawnWasm, AsyncTask, BlockingModuleTask, BlockingTask,
};

/// A message that will be sent from the scheduler to a worker using
/// `postMessage()`.
#[derive(Debug)]
pub(crate) enum PostMessagePayload {
    Async(AsyncJob),
    Blocking(BlockingJob),
    Notification(Notification),
}

impl PostMessagePayload {
    pub(crate) fn would_block(&self) -> bool {
        matches!(self, PostMessagePayload::Blocking(_))
    }
}

#[derive(Derivative)]
#[derivative(Debug)]
pub(crate) enum BlockingJob {
    Thunk(#[derivative(Debug(format_with = "crate::utils::hidden"))] BlockingTask),
    SpawnWithModule {
        module: WebAssembly::Module,
        #[derivative(Debug(format_with = "crate::utils::hidden"))]
        task: BlockingModuleTask,
    },
    SpawnWithModuleAndMemory {
        module: WebAssembly::Module,
        /// An instance of the WebAssembly linear memory that has already been
        /// created.
        memory: Option<WebAssembly::Memory>,
        spawn_wasm: SpawnWasm,
    },
}

#[derive(Derivative)]
#[derivative(Debug)]
pub(crate) enum AsyncJob {
    Thunk(#[derivative(Debug(format_with = "crate::utils::hidden"))] AsyncTask),
}

#[derive(Derivative)]
#[derivative(Debug)]
pub(crate) enum Notification {
    CacheModule {
        hash: ModuleHash,
        module: WebAssembly::Module,
    },
}

mod consts {
    pub(crate) const TYPE_SPAWN_ASYNC: &str = "spawn-async";
    pub(crate) const TYPE_SPAWN_BLOCKING: &str = "spawn-blocking";
    pub(crate) const TYPE_CACHE_MODULE: &str = "cache-module";
    pub(crate) const TYPE_SPAWN_WITH_MODULE: &str = "spawn-with-module";
    pub(crate) const TYPE_SPAWN_WITH_MODULE_AND_MEMORY: &str = "spawn-with-module-and-memory";
    pub(crate) const PTR: &str = "ptr";
    pub(crate) const MODULE: &str = "module";
    pub(crate) const MEMORY: &str = "memory";
    pub(crate) const MODULE_HASH: &str = "module-hash";
}

impl PostMessagePayload {
    pub(crate) fn into_js(self) -> Result<JsValue, crate::utils::Error> {
        match self {
            PostMessagePayload::Async(AsyncJob::Thunk(task)) => {
                Serializer::new(consts::TYPE_SPAWN_ASYNC)
                    .boxed(consts::PTR, task)
                    .finish()
            }
            PostMessagePayload::Blocking(BlockingJob::Thunk(task)) => {
                Serializer::new(consts::TYPE_SPAWN_BLOCKING)
                    .boxed(consts::PTR, task)
                    .finish()
            }
            PostMessagePayload::Blocking(BlockingJob::SpawnWithModule { module, task }) => {
                Serializer::new(consts::TYPE_SPAWN_WITH_MODULE)
                    .boxed(consts::PTR, task)
                    .set(consts::MODULE, module)
                    .finish()
            }
            PostMessagePayload::Blocking(BlockingJob::SpawnWithModuleAndMemory {
                module,
                memory,
                spawn_wasm,
            }) => Serializer::new(consts::TYPE_SPAWN_WITH_MODULE_AND_MEMORY)
                .boxed(consts::PTR, spawn_wasm)
                .set(consts::MODULE, module)
                .set(consts::MEMORY, memory)
                .finish(),
            PostMessagePayload::Notification(Notification::CacheModule { hash, module }) => {
                Serializer::new(consts::TYPE_CACHE_MODULE)
                    .set(consts::MODULE_HASH, hash.to_string())
                    .set(consts::MODULE, module)
                    .finish()
            }
        }
    }

    /// Try to convert a [`PostMessagePayload`] back from a [`JsValue`].
    ///
    /// # Safety
    ///
    /// This can only be called if the original [`JsValue`] was created using
    /// [`PostMessagePayload::into_js()`].
    pub(crate) unsafe fn try_from_js(value: JsValue) -> Result<Self, crate::utils::Error> {
        let de = crate::tasks::interop::Deserializer::new(value);

        // Safety: Keep this in sync with PostMessagePayload::to_js()
        match de.ty()?.as_str() {
            consts::TYPE_SPAWN_ASYNC => {
                let task = de.boxed(consts::PTR)?;
                Ok(PostMessagePayload::Async(AsyncJob::Thunk(task)))
            }
            consts::TYPE_SPAWN_BLOCKING => {
                let task = de.boxed(consts::PTR)?;
                Ok(PostMessagePayload::Blocking(BlockingJob::Thunk(task)))
            }
            consts::TYPE_CACHE_MODULE => {
                let module = de.js(consts::MODULE)?;
                let hash = de.string(consts::MODULE_HASH)?;
                let hash = if let Ok(hash) = ModuleHash::sha256_parse_hex(&hash) {
                    hash
                } else {
                    ModuleHash::xxhash_parse_hex(&hash)?
                };

                Ok(PostMessagePayload::Notification(
                    Notification::CacheModule { hash, module },
                ))
            }
            consts::TYPE_SPAWN_WITH_MODULE => {
                let task = de.boxed(consts::PTR)?;
                let module = de.js(consts::MODULE)?;

                Ok(PostMessagePayload::Blocking(BlockingJob::SpawnWithModule {
                    module,
                    task,
                }))
            }
            consts::TYPE_SPAWN_WITH_MODULE_AND_MEMORY => {
                let module = de.js(consts::MODULE)?;
                let memory = de.js(consts::MEMORY).ok();
                let spawn_wasm = de.boxed(consts::PTR)?;

                Ok(PostMessagePayload::Blocking(
                    BlockingJob::SpawnWithModuleAndMemory {
                        module,
                        memory,
                        spawn_wasm,
                    },
                ))
            }
            other => Err(anyhow::anyhow!("Unknown message type: {other}").into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    use futures::channel::oneshot;
    use wasm_bindgen::JsCast;
    use wasm_bindgen_test::wasm_bindgen_test;
    use wasmer::js::AsJs;
    use wasmer_wasix::{runtime::task_manager::TaskWasm, WasiEnvBuilder};

    use crate::{runtime::Runtime, tasks::SchedulerMessage};

    use super::*;

    #[wasm_bindgen_test]
    async fn round_trip_spawn_blocking() {
        let flag = Arc::new(AtomicBool::new(false));
        let msg = PostMessagePayload::Blocking(BlockingJob::Thunk({
            let flag = Arc::clone(&flag);
            Box::new(move || {
                flag.store(true, Ordering::SeqCst);
            })
        }));

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { PostMessagePayload::try_from_js(js).unwrap() };

        match round_tripped {
            PostMessagePayload::Blocking(BlockingJob::Thunk(task)) => {
                task();
                assert!(flag.load(Ordering::SeqCst));
            }
            _ => unreachable!(),
        }
    }

    #[wasm_bindgen_test]
    async fn round_trip_spawn_async() {
        let flag = Arc::new(AtomicBool::new(false));
        let msg = PostMessagePayload::Async(AsyncJob::Thunk({
            let flag = Arc::clone(&flag);
            Box::new(move || {
                Box::pin(async move {
                    flag.store(true, Ordering::SeqCst);
                })
            })
        }));

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { PostMessagePayload::try_from_js(js).unwrap() };

        match round_tripped {
            PostMessagePayload::Async(AsyncJob::Thunk(task)) => {
                task().await;
                assert!(flag.load(Ordering::SeqCst));
            }
            _ => unreachable!(),
        }
    }

    #[wasm_bindgen_test]
    async fn round_trip_spawn_with_module() {
        let wasm: &[u8] = include_bytes!("../../tests/envvar.wasm");
        let engine = wasmer::Engine::default();
        let module = wasmer::Module::new(&engine, wasm).unwrap();
        let (sender, receiver) = oneshot::channel();
        let msg = PostMessagePayload::Blocking(BlockingJob::SpawnWithModule {
            module: JsValue::from(module).dyn_into().unwrap(),
            task: Box::new(|m| {
                sender
                    .send(
                        m.exports()
                            .map(|e| e.name().to_string())
                            .collect::<Vec<String>>(),
                    )
                    .unwrap();
            }),
        });

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { PostMessagePayload::try_from_js(js).unwrap() };

        let (module, task) = match round_tripped {
            PostMessagePayload::Blocking(BlockingJob::SpawnWithModule { module, task }) => {
                (module, task)
            }
            _ => unreachable!(),
        };
        task(module.into());
        let name = receiver.await.unwrap();
        assert_eq!(
            name,
            vec![
                "memory".to_string(),
                "__heap_base".to_string(),
                "__data_end".to_string(),
                "_start".to_string(),
                "main".to_string()
            ]
        );
    }

    #[wasm_bindgen_test]
    async fn round_trip_cache_module() {
        let wasm: &[u8] = include_bytes!("../../tests/envvar.wasm");
        let engine = wasmer::Engine::default();
        let module = wasmer::Module::new(&engine, wasm).unwrap();
        let msg = PostMessagePayload::Notification(Notification::CacheModule {
            hash: ModuleHash::xxhash(wasm),
            module: module.into(),
        });

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { PostMessagePayload::try_from_js(js).unwrap() };

        match round_tripped {
            PostMessagePayload::Notification(Notification::CacheModule { hash, module: _ }) => {
                assert_eq!(hash, ModuleHash::xxhash(wasm));
            }
            _ => unreachable!(),
        };
    }

    #[wasm_bindgen_test]
    async fn round_trip_spawn_with_module_and_memory() {
        let wasm: &[u8] = include_bytes!("../../tests/envvar.wasm");
        let engine = wasmer::Engine::default();
        let module = wasmer::Module::new(&engine, wasm).unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let runtime = Runtime::new().with_default_pool();
        let env = WasiEnvBuilder::new("program")
            .runtime(Arc::new(runtime))
            .build()
            .unwrap();
        let msg = crate::tasks::task_wasm::to_scheduler_message(TaskWasm::new(
            Box::new({
                let flag = Arc::clone(&flag);
                move |_| {
                    flag.store(true, Ordering::SeqCst);
                }
            }),
            env,
            module,
            false,
        ))
        .unwrap();
        let msg = match msg {
            SchedulerMessage::SpawnWithModuleAndMemory {
                module,
                memory,
                spawn_wasm,
            } => PostMessagePayload::Blocking(BlockingJob::SpawnWithModuleAndMemory {
                module: module.into(),
                memory: memory.map(|m| m.as_jsvalue(&wasmer::Store::default()).dyn_into().unwrap()),
                spawn_wasm,
            }),
            _ => unreachable!(),
        };

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { PostMessagePayload::try_from_js(js).unwrap() };

        let (module, memory, spawn_wasm) = match round_tripped {
            PostMessagePayload::Blocking(BlockingJob::SpawnWithModuleAndMemory {
                module,
                memory,
                spawn_wasm,
            }) => (module, memory, spawn_wasm),
            _ => unreachable!(),
        };
        spawn_wasm
            .begin()
            .await
            .execute(module, memory.into())
            .await
            .unwrap();
        assert!(flag.load(Ordering::SeqCst));
    }
}
