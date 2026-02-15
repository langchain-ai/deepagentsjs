use std::{fmt::Debug, future::Future, pin::Pin};

use futures::future::LocalBoxFuture;
use instant::Duration;
use wasm_bindgen_futures::JsFuture;
use wasmer_wasix::{runtime::task_manager::TaskWasm, VirtualTaskManager, WasiThreadError};

use crate::{
    tasks::{Scheduler, SchedulerMessage},
    utils::GlobalScope,
};

/// A handle to a threadpool backed by Web Workers.
#[derive(Debug, Clone)]
pub struct ThreadPool {
    scheduler: Scheduler,
}

const CROSS_ORIGIN_WARNING: &str = r#"You can only run packages from "Cross-Origin Isolated" websites. For more details, check out https://docs.wasmer.io/javascript-sdk/explainers/troubleshooting#sharedarraybuffer-and-cross-origin-isolation"#;

impl ThreadPool {
    pub fn new() -> Self {
        if let Some(cross_origin_isolated) =
            crate::utils::GlobalScope::current().cross_origin_isolated()
        {
            // Note: This will need to be tweaked when we add support for Deno and
            // NodeJS.
            web_sys::console::assert_with_condition_and_data_1(
                cross_origin_isolated,
                &wasm_bindgen::JsValue::from_str(CROSS_ORIGIN_WARNING),
            );
        }

        let sender = Scheduler::spawn();
        ThreadPool { scheduler: sender }
    }

    /// Run an `async` function to completion on the threadpool.
    pub fn spawn(
        &self,
        task: Box<dyn FnOnce() -> LocalBoxFuture<'static, ()> + Send>,
    ) -> Result<(), WasiThreadError> {
        self.send(SchedulerMessage::SpawnAsync(task));

        Ok(())
    }

    pub(crate) fn send(&self, msg: SchedulerMessage) {
        self.scheduler.send(msg).expect("scheduler is dead");
    }

    pub fn close(&self) {
        self.scheduler.close();
    }
}

impl Drop for ThreadPool {
    fn drop(&mut self) {
        tracing::debug!("Terminating ThreadPool");
        // self.scheduler.close();
    }
}

#[async_trait::async_trait]
impl VirtualTaskManager for ThreadPool {
    /// Invokes whenever a WASM thread goes idle. In some runtimes (like
    /// singlethreaded execution environments) they will need to do asynchronous
    /// work whenever the main thread goes idle and this is the place to hook
    /// for that.
    fn sleep_now(
        &self,
        time: Duration,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + Sync + 'static>> {
        let (tx, rx) = tokio::sync::oneshot::channel();

        let time = if time.as_millis() < i32::MAX as u128 {
            time.as_millis() as i32
        } else {
            i32::MAX
        };

        // Note: We can't use wasm_bindgen_futures::spawn_local() directly
        // because we might be invoked from inside a syscall. This causes a
        // deadlock because the syscall will block block until the future
        // resolves, but the JsFuture will never get a chance to mark itself as
        // resolved because the JavaScript VM is still blocked by the syscall.
        let _ = self.task_dedicated(Box::new(move || {
            wasm_bindgen_futures::spawn_local(async move {
                let global = GlobalScope::current();
                let _ = JsFuture::from(global.sleep(time)).await;
                let _ = tx.send(());
            })
        }));

        Box::pin(async move {
            let _ = rx.await;
        })
    }

    /// Starts an asynchronous task that will run on a shared worker pool
    /// This task must not block the execution or it could cause a deadlock
    fn task_shared(
        &self,
        task: Box<
            dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> + Send + 'static,
        >,
    ) -> Result<(), WasiThreadError> {
        self.spawn(Box::new(move || Box::pin(async move { task().await })))
    }

    /// Starts an asynchronous task will will run on a dedicated thread
    /// pulled from the worker pool that has a stateful thread local variable
    /// It is ok for this task to block execution and any async futures within its scope
    fn task_wasm(&self, task: TaskWasm<'_>) -> Result<(), WasiThreadError> {
        let msg = crate::tasks::task_wasm::to_scheduler_message(task)?;
        self.send(msg);
        Ok(())
    }

    /// Starts an asynchronous task will will run on a dedicated thread
    /// pulled from the worker pool. It is ok for this task to block execution
    /// and any async futures within its scope
    fn task_dedicated(
        &self,
        task: Box<dyn FnOnce() + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        self.send(SchedulerMessage::SpawnBlocking(task));

        Ok(())
    }

    /// Returns the amount of parallelism that is possible on this platform
    fn thread_parallelism(&self) -> Result<usize, WasiThreadError> {
        match crate::utils::GlobalScope::current().hardware_concurrency() {
            Some(n) => Ok(n.get()),
            None => Err(WasiThreadError::Unsupported),
        }
    }

    fn spawn_with_module(
        &self,
        module: wasmer::Module,
        task: Box<dyn FnOnce(wasmer::Module) + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        self.send(SchedulerMessage::SpawnWithModule { task, module });

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use futures::{channel::oneshot, FutureExt};
    use js_sys::Uint8Array;
    use wasm_bindgen::JsCast;
    use wasm_bindgen_futures::JsFuture;
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::*;

    #[wasm_bindgen_test]
    async fn transfer_module_to_worker() {
        let wasm: &[u8] = include_bytes!("../../tests/envvar.wasm");
        let data = Uint8Array::from(wasm);
        let module: js_sys::WebAssembly::Module =
            JsFuture::from(js_sys::WebAssembly::compile(&data))
                .await
                .unwrap()
                .dyn_into()
                .unwrap();
        let module = wasmer::Module::from(module);
        let pool = ThreadPool::new();

        let (sender, receiver) = oneshot::channel();
        pool.spawn_with_module(
            module.clone(),
            Box::new(move |module| {
                let exports = module.exports().count();
                sender.send(exports).unwrap();
            }),
        )
        .unwrap();

        let exports = receiver.await.unwrap();
        assert_eq!(exports, 5);
    }

    #[wasm_bindgen_test]
    async fn spawned_tasks_can_communicate_with_the_main_thread() {
        let pool = ThreadPool::new();
        let (sender, receiver) = oneshot::channel();

        pool.task_shared(Box::new(move || {
            Box::pin(async move {
                sender.send(42_u32).unwrap();
            })
        }))
        .unwrap();

        tracing::info!("Waiting for result");
        let result = receiver.await.unwrap();
        tracing::info!("Received {result}");
        assert_eq!(result, 42);
    }

    /// This is a regression test for [#355].
    ///
    /// Here is a description of the original bug:
    ///
    /// > There is a small time between spawning a new Web Worker and when it
    /// > starts handling its first message. During this time, the worker will be
    /// > considered "idle" and the scheduler will start sending work to it.
    /// >
    /// > That means if you spawn a large number of WASIX threads in quick
    /// > succession, all of those blocking tasks can be sent to the same newly
    /// > spawned worker, rather than being sent to their own worker. If the
    /// > threads depend on each other to make progress, we'll trigger a deadlock.
    /// >
    /// > This is what we're seeing when running `ffmpeg`.
    ///
    /// [#355]: https://github.com/wasmerio/wasmer-js/pull/355
    #[wasm_bindgen_test]
    async fn spawn_interdependent_blocking_tasks_out_of_order() {
        let (sender_1, receiver_1) = oneshot::channel();
        let (sender_2, mut receiver_2) = oneshot::channel();
        // Set things up so we can run 2 blocking tasks at the same time.
        let pool = ThreadPool::new();

        // Note: The second task depends on the first one completing
        let first_task = Box::new(move || sender_1.send(()).unwrap());
        let second_task = Box::new(move || {
            futures::executor::block_on(receiver_1).unwrap();
            // let the main thread know we're done
            sender_2.send(()).unwrap();
        });

        // Schedule the tasks out of order in quick succession... If there is a
        // race condition where both blocking tasks get sent to the same newly
        // created worker, this triggers it pretty reliably.
        pool.task_dedicated(second_task).unwrap();
        pool.task_dedicated(first_task).unwrap();

        // If the tasks ran correctly we should get a value. Otherwise, it'll
        // block forever.
        let timeout = JsFuture::from(crate::utils::GlobalScope::current().sleep(1000));
        futures::select! {
            _ = timeout.fuse() => {
                panic!("The task was blocked");
            }
            _ = receiver_2 => {
                // Finished successfully
            }
        }
    }
}
