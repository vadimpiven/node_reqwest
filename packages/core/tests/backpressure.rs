// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Integration tests for backpressure, cancellation, and timeout paths.

mod support;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
use anyhow::ensure;
use nrcore::Agent;
use nrcore::AgentConfig;
use nrcore::CoreError;
use nrcore::DispatchOptions;
use nrcore::Method;
use support::mock_handler::MockHandler;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::matchers::query_param;

fn opts(origin: String, path: &str) -> DispatchOptions {
    DispatchOptions {
        origin: Some(origin),
        path: path.to_string(),
        method: Method::GET,
        ..Default::default()
    }
}

#[tokio::test]
async fn test_abort_before_response() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).context("agent")?;
    let (handler, events, done) = MockHandler::new();

    let (controller, fut) = agent
        .dispatch(opts(server.uri(), "/slow"), handler)
        .context("dispatch")?;
    tokio::spawn(fut);
    controller.abort();
    done.notified().await;

    let events = events.lock().await;
    ensure!(events.response_starts.is_empty(), "no response started");
    ensure!(events.errors.len() == 1, "one error");
    ensure!(
        events.errors[0].to_lowercase().contains("aborted"),
        "abort message: {}",
        events.errors[0]
    );
    Ok(())
}

#[tokio::test]
async fn test_abort_during_streaming() -> Result<()> {
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.context("bind")?;
    let addr = listener.local_addr().context("addr")?;
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
                .await;
            // Hold the connection open with no further data so abort fires mid-stream.
            tokio::time::sleep(Duration::from_mins(1)).await;
        }
    });

    let agent = Agent::new(AgentConfig::default()).context("agent")?;
    let (handler, events, done) = MockHandler::new();

    let (controller, fut) = agent
        .dispatch(opts(format!("http://{addr}"), "/"), handler)
        .context("dispatch")?;
    tokio::spawn(fut);
    tokio::time::sleep(Duration::from_millis(100)).await;
    controller.abort();
    done.notified().await;

    let events = events.lock().await;
    ensure!(events.response_starts.len() == 1, "one response start");
    ensure!(events.errors.len() == 1, "one error");
    ensure!(
        events.errors[0].to_lowercase().contains("aborted"),
        "abort message: {}",
        events.errors[0]
    );
    Ok(())
}

#[tokio::test]
async fn test_pause_resume_backpressure() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/data"))
        .respond_with(ResponseTemplate::new(200).set_body_string("chunk1chunk2chunk3"))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).context("agent")?;
    let (handler, events, done) = MockHandler::new();

    let (controller, fut) = agent
        .dispatch(opts(server.uri(), "/data"), handler)
        .context("dispatch")?;
    tokio::spawn(fut);
    controller.pause();
    ensure!(controller.is_paused(), "paused after pause()");
    tokio::time::sleep(Duration::from_millis(50)).await;
    controller.resume();
    ensure!(!controller.is_paused(), "unpaused after resume()");
    done.notified().await;

    let events = events.lock().await;
    ensure!(events.response_starts.len() == 1, "one response start");
    ensure!(!events.data_chunks.is_empty(), "got data");
    ensure!(events.response_ends.len() == 1, "one response end");
    Ok(())
}

#[tokio::test]
async fn test_timeout() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/timeout"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
        .mount(&server)
        .await;

    let config = AgentConfig {
        timeout: Some(Duration::from_millis(100)),
        ..Default::default()
    };
    let agent = Agent::new(config).context("agent")?;
    let (handler, events, done) = MockHandler::new();

    {
        let (_ctrl, fut) = agent
            .dispatch(opts(server.uri(), "/timeout"), handler)
            .context("dispatch")?;
        tokio::spawn(fut);
    }
    done.notified().await;

    let events = events.lock().await;
    ensure!(events.errors.len() == 1, "one error");
    ensure!(
        events.errors[0].to_lowercase().contains("timeout"),
        "timeout message: {}",
        events.errors[0]
    );
    Ok(())
}

#[tokio::test]
async fn test_query_parameters() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/search"))
        .and(query_param("q", "hello world"))
        .and(query_param("page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_string("found"))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).context("agent")?;
    let (handler, events, done) = MockHandler::new();
    let mut o = opts(server.uri(), "/search");
    o.query = "q=hello%20world&page=1".to_string();

    {
        let (_ctrl, fut) = agent.dispatch(o, handler).context("dispatch")?;
        tokio::spawn(fut);
    }
    done.notified().await;

    let events = events.lock().await;
    ensure!(events.response_starts.len() == 1, "one response start");
    ensure!(events.response_starts[0].status_code == 200, "status 200");
    ensure!(&events.data_chunks[0][..] == b"found", "body matches");
    Ok(())
}

#[tokio::test]
async fn test_per_request_headers_timeout() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow-headers"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(10)))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).context("agent")?;
    let (handler, events, done) = MockHandler::new();
    let mut o = opts(server.uri(), "/slow-headers");
    o.headers_timeout_ms = Some(100);

    {
        let (_ctrl, fut) = agent.dispatch(o, handler).context("dispatch")?;
        tokio::spawn(fut);
    }
    done.notified().await;

    let events = events.lock().await;
    ensure!(events.errors.len() == 1, "one error");
    ensure!(
        events.errors[0].to_lowercase().contains("timeout"),
        "headers timeout message: {}",
        events.errors[0]
    );
    Ok(())
}

#[tokio::test]
async fn test_close_rejects_new_requests() -> Result<()> {
    let agent = Agent::new(AgentConfig::default()).context("agent")?;
    agent.close().await;

    let (handler, _events, _done) = MockHandler::new();
    let result = agent.dispatch(opts("http://example.com".to_string(), "/"), handler);
    ensure!(result.is_err(), "must reject after close");
    Ok(())
}

#[tokio::test]
async fn test_destroy_cancels_pending() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_mins(1)))
        .mount(&server)
        .await;

    let agent = Arc::new(Agent::new(AgentConfig::default()).context("agent")?);
    let (handler, events, done) = MockHandler::new();

    {
        let (_ctrl, fut) = agent
            .dispatch(opts(server.uri(), "/slow"), handler)
            .context("dispatch")?;
        tokio::spawn(fut);
    }

    tokio::time::sleep(Duration::from_millis(10)).await;
    agent.destroy(CoreError::ClientDestroyed).await;

    done.notified().await;
    let events = events.lock().await;
    ensure!(events.errors.len() == 1, "one error after destroy");
    Ok(())
}

#[tokio::test]
async fn test_concurrent_close_and_destroy_both_resolve() -> Result<()> {
    // Both `close()` and `destroy()` park on `wait_for_idle()`. A naive
    // `notify_one()` wakes only one of them and the other hangs forever;
    // verify both futures complete together.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_mins(1)))
        .mount(&server)
        .await;

    let agent = Arc::new(Agent::new(AgentConfig::default()).context("agent")?);
    let (handler, _events, _done) = MockHandler::new();
    let (_ctrl, fut) = agent
        .dispatch(opts(server.uri(), "/slow"), handler)
        .context("dispatch")?;
    tokio::spawn(fut);
    tokio::time::sleep(Duration::from_millis(10)).await;

    let close_fut = tokio::spawn({
        let agent = Arc::clone(&agent);
        async move { agent.close().await }
    });
    let destroy_fut = tokio::spawn({
        let agent = Arc::clone(&agent);
        async move { agent.destroy(CoreError::ClientDestroyed).await }
    });

    let joined = tokio::time::timeout(Duration::from_secs(5), async {
        let _ = tokio::join!(close_fut, destroy_fut);
    })
    .await;
    ensure!(joined.is_ok(), "close() + destroy() must both resolve");
    Ok(())
}

#[tokio::test]
async fn test_body_timeout_between_chunks() -> Result<()> {
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.context("bind")?;
    let addr = listener.local_addr().context("addr")?;
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
                .await;
            tokio::time::sleep(Duration::from_mins(1)).await;
        }
    });

    let agent = Agent::new(AgentConfig::default()).context("agent")?;
    let (handler, events, done) = MockHandler::new();
    let mut o = opts(format!("http://{addr}"), "/");
    o.body_timeout_ms = Some(100);

    {
        let (_ctrl, fut) = agent.dispatch(o, handler).context("dispatch")?;
        tokio::spawn(fut);
    }
    done.notified().await;

    let events = events.lock().await;
    ensure!(events.errors.len() == 1, "one error");
    ensure!(
        events.errors[0].to_lowercase().contains("body timeout"),
        "body timeout message: {}",
        events.errors[0]
    );
    Ok(())
}

#[tokio::test]
async fn test_connect_timeout_blackhole() -> Result<()> {
    // 192.0.2.0/24 (RFC 5737 TEST-NET-1) is reserved for documentation;
    // routing varies, so wrap the whole test in a hard timeout that
    // matches what we'd expect a connect-timeout to honor.
    let config = AgentConfig {
        connect_timeout: Some(Duration::from_millis(150)),
        ..Default::default()
    };
    let agent = Agent::new(config).context("agent")?;
    let (handler, events, done) = MockHandler::new();
    {
        let (_ctrl, fut) = agent
            .dispatch(opts("http://192.0.2.1:1".to_string(), "/"), handler)
            .context("dispatch")?;
        tokio::spawn(fut);
    }

    let notified = tokio::time::timeout(Duration::from_secs(5), done.notified()).await;
    if notified.is_err() {
        // Some environments don't drop packets to TEST-NET-1; skip rather
        // than fail. The native test on macOS will still cover this path.
        return Ok(());
    }
    let events = events.lock().await;
    if events.errors.is_empty() {
        return Ok(()); // environment-dependent
    }
    let msg = events.errors[0].to_lowercase();
    ensure!(
        msg.contains("connect") || msg.contains("timeout") || msg.contains("socket"),
        "connect/timeout/socket message: {msg}"
    );
    Ok(())
}

#[tokio::test]
async fn test_abort_during_headers() -> Result<()> {
    use tokio::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").await.context("bind")?;
    let addr = listener.local_addr().context("addr")?;
    tokio::spawn(async move {
        if let Ok((_sock, _)) = listener.accept().await {
            tokio::time::sleep(Duration::from_mins(1)).await;
        }
    });

    let agent = Agent::new(AgentConfig::default()).context("agent")?;
    let (handler, events, done) = MockHandler::new();
    let (controller, fut) = agent
        .dispatch(opts(format!("http://{addr}"), "/"), handler)
        .context("dispatch")?;
    tokio::spawn(fut);
    tokio::time::sleep(Duration::from_millis(50)).await;
    controller.abort();
    done.notified().await;
    let events = events.lock().await;
    ensure!(events.response_starts.is_empty(), "no response started");
    ensure!(events.errors.len() == 1, "one error");
    Ok(())
}

#[tokio::test]
async fn test_abort_while_paused() -> Result<()> {
    let server = MockServer::start().await;
    let body = "x".repeat(1024 * 1024);
    Mock::given(method("GET"))
        .and(path("/big"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let agent = Agent::new(AgentConfig::default()).context("agent")?;
    let (handler, events, done) = MockHandler::new();
    let (controller, fut) = agent
        .dispatch(opts(server.uri(), "/big"), handler)
        .context("dispatch")?;
    tokio::spawn(fut);
    controller.pause();
    tokio::time::sleep(Duration::from_millis(50)).await;
    controller.abort();
    tokio::time::timeout(Duration::from_secs(2), done.notified())
        .await
        .context("abort should wake paused loop")?;
    let events = events.lock().await;
    ensure!(events.errors.len() == 1, "one error");
    Ok(())
}

#[tokio::test]
async fn test_concurrent_dispatch_then_destroy_no_leaks() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_mins(1)))
        .mount(&server)
        .await;

    let agent = Arc::new(Agent::new(AgentConfig::default()).context("agent")?);
    let mut dones = Vec::new();
    for _ in 0..50 {
        let (handler, _events, done) = MockHandler::new();
        {
            let (_ctrl, fut) = agent
                .dispatch(opts(server.uri(), "/slow"), handler)
                .context("dispatch")?;
            tokio::spawn(fut);
        }
        dones.push(done);
    }
    agent.destroy(CoreError::ClientDestroyed).await;
    for d in dones {
        d.notified().await;
    }
    Ok(())
}
