//! A thread pool implementation backed by web workers.
//!
//! # Design
//!
//! The thread pool implementation is based on the actor model, where the
//! various components will send messages to each other.
//!
//! The main components:
//! - [`Scheduler`] - the core logic for communicating with workers and
//!   scheduling work
//! - [`ThreadPool`] - a cheaply copyable implementation of
//!   [`wasmer_wasix::runtime::task_manager::VirtualTaskManager`] that works by
//!   sending messages to the [`Scheduler`]
//! - [`WorkerHandle`] - a `!Send` handle used by the [`Scheduler`] to manage
//!   a worker's lifecycle and communicate back and forth with it
//! - [`Worker`] - a worker's internal state
//!
//! Communicating with workers is a bit tricky because of their asynchronous
//! nature and the requirement to use `postMessage()` when transferring certain
//! JavaScript objects between workers and the main thread. Often, this requires
//! the message to go through some `postMessage()`-friendly intermediate
//! representation.
//!
//! The main message types:
//! - [`SchedulerMessage`] - messages sent from the [`ThreadPool`] and
//!   [`crate::runtime::Runtime`] to the [`Scheduler`]
//! - [`PostMessagePayload`] - messages the [`Scheduler`] sends to a
//!   [`Worker`]
//! - [`WorkerMessage`] - messages a [`Worker`] sends back to the [`Scheduler`]
//!
//! [`Worker`]: thread_pool_worker::ThreadPoolWorker
//! [`Scheduler`]: scheduler::Scheduler

mod interop;
mod post_message_payload;
mod scheduler;
mod scheduler_message;
mod task_wasm;
mod thread_pool;
mod thread_pool_worker;
mod worker_handle;
mod worker_message;

pub(crate) use self::{
    post_message_payload::{AsyncJob, BlockingJob, Notification, PostMessagePayload},
    scheduler::Scheduler,
    scheduler_message::SchedulerMessage,
    thread_pool::ThreadPool,
    worker_handle::WorkerHandle,
    worker_message::WorkerMessage,
};

use std::{future::Future, pin::Pin};

type AsyncTask = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + 'static>> + Send + 'static>;
type BlockingTask = Box<dyn FnOnce() + Send + 'static>;
type BlockingModuleTask = Box<dyn FnOnce(wasmer::Module) + Send + 'static>;
