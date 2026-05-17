// SPDX-License-Identifier: Apache-2.0 OR MIT

use std::collections::HashMap;
use std::sync::Arc;

use bytes::Bytes;
use nrcore::CoreError;
use nrcore::DispatchHandler;
use nrcore::ResponseStart;
use tokio::sync::Mutex;
use tokio::sync::Notify;

pub type Trailers = HashMap<String, Vec<String>>;
pub type EventsHandle = Arc<Mutex<RecordedEvents>>;
pub type DoneHandle = Arc<Notify>;

#[derive(Default)]
pub struct RecordedEvents {
    pub response_starts: Vec<ResponseStart>,
    pub data_chunks: Vec<Bytes>,
    pub response_ends: Vec<Trailers>,
    pub errors: Vec<String>,
}

pub struct MockHandler {
    events: EventsHandle,
    done: DoneHandle,
}

impl MockHandler {
    pub fn new() -> (Self, EventsHandle, DoneHandle) {
        let events = Arc::new(Mutex::new(RecordedEvents::default()));
        let done = Arc::new(Notify::new());
        (
            Self {
                events: Arc::clone(&events),
                done: Arc::clone(&done),
            },
            events,
            done,
        )
    }
}

impl DispatchHandler for MockHandler {
    async fn on_response_start(&self, response: ResponseStart) {
        self.events.lock().await.response_starts.push(response);
    }

    async fn on_response_data(&self, chunk: Bytes) {
        self.events.lock().await.data_chunks.push(chunk);
    }

    async fn on_response_end(&self, trailers: Trailers) {
        self.events.lock().await.response_ends.push(trailers);
        self.done.notify_one();
    }

    async fn on_response_error(&self, error: CoreError) {
        self.events.lock().await.errors.push(error.to_string());
        self.done.notify_one();
    }
}
