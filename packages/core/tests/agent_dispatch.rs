// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Integration tests for `Agent::dispatch` happy-path behavior.

mod support;

use anyhow::Context;
use anyhow::Result;
use anyhow::ensure;
use nrcore::Agent;
use nrcore::AgentConfig;
use nrcore::DispatchOptions;
use nrcore::Method;
use support::mock_handler::MockHandler;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;

#[tokio::test]
async fn test_get_200_ok() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/test"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hello"))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).context("agent")?;
    let (handler, events, done) = MockHandler::new();
    let opts = DispatchOptions {
        origin: Some(server.uri()),
        path: "/test".to_string(),
        method: Method::GET,
        ..Default::default()
    };

    let (_ctrl, fut) = agent.dispatch(opts, handler).context("dispatch")?;
    tokio::spawn(fut);
    done.notified().await;

    let events = events.lock().await;
    ensure!(events.response_starts.len() == 1, "one response start");
    ensure!(events.response_starts[0].status_code == 200, "status 200");
    ensure!(events.data_chunks.len() == 1, "one data chunk");
    ensure!(&events.data_chunks[0][..] == b"hello", "body matches");
    ensure!(events.response_ends.len() == 1, "one response end");
    ensure!(events.errors.is_empty(), "no errors");
    Ok(())
}
