// SPDX-License-Identifier: Apache-2.0 OR MIT

//! Core library for `node_reqwest`: undici-compatible HTTP dispatcher.

pub mod agent;
pub mod dispatcher;
pub mod error;

pub use agent::Agent;
pub use agent::AgentConfig;
pub use agent::DispatchFuture;
pub use agent::DispatchHandle;
pub use agent::ProxyAuth;
pub use agent::ProxyConfig;
pub use dispatcher::DispatchHandler;
pub use dispatcher::DispatchOptions;
pub use dispatcher::MAX_HEADERS;
pub use dispatcher::Method;
pub use dispatcher::PauseState;
pub use dispatcher::RequestController;
pub use dispatcher::ResponseStart;
pub use dispatcher::parse_method;
pub use error::CoreError;
