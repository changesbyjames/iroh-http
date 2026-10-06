//! Errors raised while framing or parsing an Iroh HTTP exchange.

/// A boxed source error from the transport or an application body.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// An error raised while framing or parsing an Iroh HTTP exchange.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// The peer sent something `SPEC.md` does not permit.
    #[error("protocol violation: {0}")]
    Protocol(String),

    /// The peer terminated a body with an `ERROR` frame.
    #[error("remote body failed: {0}")]
    RemoteBody(String),

    /// A local body produced an error while being sent.
    #[error("body failed: {0}")]
    Body(String),

    /// The underlying Iroh connection or stream failed.
    #[error("transport failed: {0}")]
    Transport(#[source] BoxError),

    /// A head frame could not be turned into a valid `http` message.
    #[error("invalid http message: {0}")]
    Http(#[source] BoxError),
}

impl Error {
    /// Wrap a transport failure.
    pub fn transport<E: Into<BoxError>>(error: E) -> Self {
        Self::Transport(error.into())
    }

    /// Wrap an `http` conversion failure.
    pub fn http<E: Into<BoxError>>(error: E) -> Self {
        Self::Http(error.into())
    }

    /// Build a protocol violation.
    pub fn protocol<M: Into<String>>(message: M) -> Self {
        Self::Protocol(message.into())
    }
}

impl From<http::Error> for Error {
    fn from(error: http::Error) -> Self {
        Self::http(error)
    }
}
