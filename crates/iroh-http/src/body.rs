//! The body type carried by Iroh HTTP requests and responses.

use std::{
    pin::Pin,
    task::{Context, Poll},
};

use bytes::Bytes;
use http_body::{Frame, SizeHint};
use tokio::sync::mpsc;

use crate::Error;

/// A streaming HTTP body.
///
/// Implements [`http_body::Body`], so it composes with `http-body-util`,
/// `tower-http`, and `axum` without conversion.
#[derive(Debug)]
pub struct Body(Inner);

#[derive(Debug)]
enum Inner {
    Empty,
    Once(Option<Bytes>),
    Channel(mpsc::Receiver<Result<Bytes, Error>>),
}

impl Body {
    /// An empty body.
    #[must_use]
    pub fn empty() -> Self {
        Self(Inner::Empty)
    }

    /// A body consisting of exactly one chunk.
    #[must_use]
    pub fn once(bytes: impl Into<Bytes>) -> Self {
        let bytes = bytes.into();
        if bytes.is_empty() {
            Self::empty()
        } else {
            Self(Inner::Once(Some(bytes)))
        }
    }

    /// A body fed by a channel, for producers that stream chunks over time.
    ///
    /// `capacity` bounds how many chunks may be buffered ahead of the consumer,
    /// which is what applies backpressure to the producer.
    #[must_use]
    pub fn channel(capacity: usize) -> (BodySender, Self) {
        let (sender, receiver) = mpsc::channel(capacity);
        (BodySender(sender), Self(Inner::Channel(receiver)))
    }
}

/// The producing half of [`Body::channel`].
///
/// Dropping the sender ends the body cleanly. Use [`BodySender::fail`] to end it
/// with an error instead, which the peer receives as an `ERROR` body frame.
#[derive(Debug, Clone)]
pub struct BodySender(mpsc::Sender<Result<Bytes, Error>>);

impl BodySender {
    /// Append a chunk, waiting if the consumer is behind.
    ///
    /// Returns `Err` once the consumer has gone away.
    pub async fn send(&self, chunk: impl Into<Bytes>) -> Result<(), Error> {
        self.0
            .send(Ok(chunk.into()))
            .await
            .map_err(|_| Error::Body("body consumer went away".to_owned()))
    }

    /// End the body with a failure rather than a clean close.
    pub async fn fail(self, error: Error) {
        let _ = self.0.send(Err(error)).await;
    }

    /// The underlying channel, used by the wire reader to forward frames.
    pub(crate) fn into_inner(self) -> mpsc::Sender<Result<Bytes, Error>> {
        self.0
    }
}

impl Default for Body {
    fn default() -> Self {
        Self::empty()
    }
}

impl From<Bytes> for Body {
    fn from(bytes: Bytes) -> Self {
        Self::once(bytes)
    }
}

impl From<Vec<u8>> for Body {
    fn from(bytes: Vec<u8>) -> Self {
        Self::once(bytes)
    }
}

impl From<String> for Body {
    fn from(text: String) -> Self {
        Self::once(text)
    }
}

impl From<&'static str> for Body {
    fn from(text: &'static str) -> Self {
        Self::once(text)
    }
}

impl http_body::Body for Body {
    type Data = Bytes;
    type Error = Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match &mut self.get_mut().0 {
            Inner::Empty => Poll::Ready(None),
            Inner::Once(slot) => Poll::Ready(slot.take().map(|bytes| Ok(Frame::data(bytes)))),
            Inner::Channel(receiver) => receiver
                .poll_recv(cx)
                .map(|frame| frame.map(|result| result.map(Frame::data))),
        }
    }

    fn is_end_stream(&self) -> bool {
        match &self.0 {
            Inner::Empty => true,
            Inner::Once(slot) => slot.is_none(),
            Inner::Channel(_) => false,
        }
    }

    fn size_hint(&self) -> SizeHint {
        match &self.0 {
            Inner::Once(Some(bytes)) => SizeHint::with_exact(bytes.len() as u64),
            Inner::Empty | Inner::Once(None) => SizeHint::with_exact(0),
            Inner::Channel(_) => SizeHint::default(),
        }
    }
}
