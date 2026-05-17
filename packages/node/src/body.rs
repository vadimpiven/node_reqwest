// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Streams request bodies from a JS `ReadableStreamDefaultReader<Uint8Array>`.

use std::sync::Arc;
use std::sync::Mutex;

use bytes::Bytes;
use neon::prelude::*;
use neon::types::buffer::TypedArray;
use tokio::sync::oneshot;

const MAX_CHUNK: usize = 65536;

type ChunkResult = Result<Option<Bytes>, std::io::Error>;
type ReaderHandle = Arc<Mutex<Option<Root<JsObject>>>>;

pub struct JsBodyReader {
    channel: Channel,
    reader_root: ReaderHandle,
    finished: bool,
}

impl JsBodyReader {
    pub fn new(cx: &mut FunctionContext<'_>, reader: Handle<'_, JsObject>) -> NeonResult<Self> {
        let channel = cx.channel();
        let reader_root = Arc::new(Mutex::new(Some(reader.root(cx))));
        Ok(Self {
            channel,
            reader_root,
            finished: false,
        })
    }

    pub async fn next(&mut self) -> ChunkResult {
        if self.finished {
            return Ok(None);
        }

        let (tx, rx) = oneshot::channel::<ChunkResult>();
        let reader_root = Arc::clone(&self.reader_root);
        let channel = self.channel.clone();

        channel.send(move |mut cx| {
            let reader_guard = reader_root
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(root) = reader_guard.as_ref() else {
                let _ = tx.send(Ok(None));
                return Ok(());
            };
            let reader = root.to_inner(&mut cx);
            drop(reader_guard);

            let read_promise: Handle<'_, JsPromise> =
                reader.call_method_with(&mut cx, "read")?.apply(&mut cx)?;

            let _future = read_promise.to_future(&mut cx, move |mut cx, result| match result {
                Ok(value) => {
                    let obj = value.downcast_or_throw::<JsObject, _>(&mut cx)?;
                    let done: Handle<'_, JsBoolean> = obj.get(&mut cx, "done")?;
                    if done.value(&mut cx) {
                        let _ = tx.send(Ok(None));
                        return Ok(());
                    }

                    let view: Handle<'_, JsTypedArray<u8>> = obj.get(&mut cx, "value")?;
                    let slice = view.as_slice(&cx);
                    if slice.len() > MAX_CHUNK {
                        let _ = tx.send(Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            format!("body chunk exceeds {MAX_CHUNK} bytes"),
                        )));
                        return Ok(());
                    }
                    let chunk = Bytes::copy_from_slice(slice);
                    let _ = tx.send(Ok(Some(chunk)));
                    Ok(())
                },
                Err(_e) => {
                    let _ = tx.send(Err(std::io::Error::other("request body reader error")));
                    Ok(())
                },
            })?;
            Ok(())
        });

        match rx.await {
            Ok(Ok(Some(chunk))) => Ok(Some(chunk)),
            Ok(Ok(None)) => {
                self.finished = true;
                Ok(None)
            },
            Ok(Err(e)) => {
                self.finished = true;
                Err(e)
            },
            Err(_) => {
                self.finished = true;
                Err(std::io::Error::other("body reader cancelled"))
            },
        }
    }

    pub fn into_stream(
        mut self,
    ) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
        async_stream::stream! {
            loop {
                match self.next().await {
                    Ok(Some(chunk)) => yield Ok(chunk),
                    Ok(None) => break,
                    Err(e) => {
                        yield Err(e);
                        break;
                    }
                }
            }
        }
    }
}

impl Drop for JsBodyReader {
    fn drop(&mut self) {
        let mut guard = self
            .reader_root
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(root) = guard.take() {
            let channel = self.channel.clone();
            channel.send(move |mut cx| {
                let reader = root.to_inner(&mut cx);
                if let Ok(method) = reader.call_method_with(&mut cx, "cancel") {
                    let _ = method.exec(&mut cx);
                }
                Ok(())
            });
        }
    }
}
