use wasm_bindgen::{JsCast, JsValue};
use web_sys::DedicatedWorkerGlobalScope;

use crate::{
    tasks::{
        interop::{Deserializer, Serializer},
        SchedulerMessage,
    },
    utils::Error,
};

/// A message the worker sends back to the scheduler.
#[derive(Debug)]
pub(crate) enum WorkerMessage {
    /// Mark this worker as busy.
    MarkBusy,
    /// Mark this worker as idle.
    MarkIdle,
    Scheduler(SchedulerMessage),
}

impl WorkerMessage {
    pub(crate) unsafe fn try_from_js(value: JsValue) -> Result<Self, Error> {
        let de = Deserializer::new(value);

        match de.ty()?.as_str() {
            consts::TYPE_BUSY => Ok(WorkerMessage::MarkBusy),
            consts::TYPE_IDLE => Ok(WorkerMessage::MarkIdle),
            consts::TYPE_SCHEDULER => {
                let value: JsValue = de.js(consts::MESSAGE)?;
                let msg = SchedulerMessage::try_from_js(value)?;
                Ok(WorkerMessage::Scheduler(msg))
            }
            other => Err(anyhow::anyhow!("Unknown message type, \"{other}\"").into()),
        }
    }

    pub(crate) fn into_js(self) -> Result<JsValue, Error> {
        match self {
            WorkerMessage::MarkBusy => Serializer::new(consts::TYPE_BUSY).finish(),
            WorkerMessage::MarkIdle => Serializer::new(consts::TYPE_IDLE).finish(),
            WorkerMessage::Scheduler(msg) => {
                let msg = msg.into_js()?;
                Serializer::new(consts::TYPE_SCHEDULER)
                    .set(consts::MESSAGE, msg)
                    .finish()
            }
        }
    }

    /// Send this message to the scheduler.
    pub fn emit(self) -> Result<(), Error> {
        tracing::debug!(
            current_thread = wasmer::js::current_thread_id(),
            msg=?self,
            "Sending a worker message"
        );
        let scope: DedicatedWorkerGlobalScope = js_sys::global().unchecked_into();

        let value = self.into_js()?;
        scope.post_message(&value).map_err(Error::js)?;

        tracing::debug!(
            current_thread = wasmer::js::current_thread_id(),
            "Message sent"
        );

        Ok(())
    }
}

mod consts {
    pub const TYPE_BUSY: &str = "busy";
    pub const TYPE_IDLE: &str = "idle";
    pub const TYPE_SCHEDULER: &str = "scheduler";
    pub const MESSAGE: &str = "msg";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_busy() {
        let msg = WorkerMessage::MarkBusy;

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { WorkerMessage::try_from_js(js).unwrap() };

        assert!(matches!(round_tripped, WorkerMessage::MarkBusy));
    }

    #[test]
    fn round_trip_idle() {
        let msg = WorkerMessage::MarkIdle;

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { WorkerMessage::try_from_js(js).unwrap() };

        assert!(matches!(round_tripped, WorkerMessage::MarkIdle));
    }

    #[test]
    fn round_trip_scheduler_message() {
        let msg = WorkerMessage::Scheduler(SchedulerMessage::WorkerBusy { worker_id: 42 });

        let js = msg.into_js().unwrap();
        let round_tripped = unsafe { WorkerMessage::try_from_js(js).unwrap() };

        assert!(matches!(
            round_tripped,
            WorkerMessage::Scheduler(SchedulerMessage::WorkerBusy { worker_id: 42 })
        ));
    }
}
