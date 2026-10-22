use std::fs::File;
use std::io::{BufReader, Read};
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use anyhow::{anyhow, Context as AnyhowContext, Result};
use axum::serve::{IncomingStream, Listener};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, warn};

use crate::config::Config;

#[derive(Clone, Debug)]
pub struct ConnInfo {
    pub peer: Option<SocketAddr>,
    pub tls: bool,
}

impl From<SocketAddr> for ConnInfo {
    fn from(addr: SocketAddr) -> Self {
        Self {
            peer: Some(addr),
            tls: false,
        }
    }
}

impl<'a> axum::extract::connect_info::Connected<IncomingStream<'a, TlsListener>> for ConnInfo {
    fn connect_info(stream: IncomingStream<'a, TlsListener>) -> Self {
        stream.remote_addr().clone()
    }
}

impl<'a> axum::extract::connect_info::Connected<IncomingStream<'a, TcpListener>> for ConnInfo {
    fn connect_info(stream: IncomingStream<'a, TcpListener>) -> Self {
        ConnInfo::from(*stream.remote_addr())
    }
}

#[cfg(unix)]
impl<'a> axum::extract::connect_info::Connected<IncomingStream<'a, tokio::net::UnixListener>>
    for ConnInfo
{
    fn connect_info(_stream: IncomingStream<'a, tokio::net::UnixListener>) -> Self {
        Self {
            peer: None,
            tls: false,
        }
    }
}

pub enum MaybeTlsStream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl AsyncRead for MaybeTlsStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for MaybeTlsStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

type AcceptedConnection = (MaybeTlsStream, ConnInfo);

pub struct TlsListener {
    local_addr: Option<ConnInfo>,
    received: tokio::sync::mpsc::Receiver<AcceptedConnection>,
    accept_task: Option<tokio::task::JoinHandle<()>>,
}

impl TlsListener {
    pub fn new(inner: TcpListener, acceptor: TlsAcceptor) -> Self {
        let local_addr = inner
            .local_addr()
            .map(|addr| ConnInfo {
                peer: Some(addr),
                tls: true,
            })
            .ok();
        let (sender, received) = tokio::sync::mpsc::channel(64);
        let accept_task = tokio::spawn(async move {
            loop {
                let (stream, addr) = match inner.accept().await {
                    Ok(value) => value,
                    Err(error) => {
                        warn!("accept failed: {error}");
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        continue;
                    }
                };

                let sender = sender.clone();
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let mut first = [0u8; 1];
                    let peek = tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        stream.peek(&mut first),
                    )
                    .await;
                    let is_tls = matches!(peek, Ok(Ok(1)) if first[0] == 0x16);

                    if is_tls {
                        match tokio::time::timeout(
                            std::time::Duration::from_secs(30),
                            acceptor.accept(stream),
                        )
                        .await
                        {
                            Ok(Ok(stream)) => {
                                let _ = sender
                                    .send((
                                        MaybeTlsStream::Tls(Box::new(stream)),
                                        ConnInfo {
                                            peer: Some(addr),
                                            tls: true,
                                        },
                                    ))
                                    .await;
                            }
                            Ok(Err(error)) => {
                                debug!("TLS handshake failed from {addr}: {error}");
                            }
                            Err(_) => {
                                debug!("TLS handshake timed out from {addr}");
                            }
                        }
                    } else if matches!(peek, Ok(Ok(1))) {
                        let _ = sender
                            .send((
                                MaybeTlsStream::Plain(stream),
                                ConnInfo {
                                    peer: Some(addr),
                                    tls: false,
                                },
                            ))
                            .await;
                    }
                });
            }
        });

        Self {
            local_addr,
            received,
            accept_task: Some(accept_task),
        }
    }
}

impl Drop for TlsListener {
    fn drop(&mut self) {
        if let Some(task) = self.accept_task.take() {
            task.abort();
        }
    }
}

impl Listener for TlsListener {
    type Io = MaybeTlsStream;
    type Addr = ConnInfo;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            if let Some(connection) = self.received.recv().await {
                return connection;
            }
            std::future::pending::<()>().await;
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.local_addr
            .clone()
            .ok_or_else(|| std::io::Error::other("local address is unavailable"))
    }
}

pub fn build_acceptor(config: &Config) -> Result<TlsAcceptor> {
    let cert_path = config
        .ssl_cert
        .as_ref()
        .ok_or_else(|| anyhow!("missing SSL certificate"))?;
    let key_path = config
        .ssl_key
        .as_ref()
        .ok_or_else(|| anyhow!("missing SSL private key"))?;

    let certs = load_certs(cert_path)?;
    let key = load_private_key(key_path)?;

    let builder = if let Some(ca_path) = &config.ssl_ca {
        let mut roots = RootCertStore::empty();
        for cert in load_certs(ca_path)? {
            roots
                .add(cert)
                .with_context(|| format!("invalid CA certificate in {}", ca_path.display()))?;
        }
        let verifier = WebPkiClientVerifier::builder(Arc::new(roots))
            .build()
            .context("failed to build client certificate verifier")?;
        ServerConfig::builder().with_client_cert_verifier(verifier)
    } else {
        ServerConfig::builder().with_no_client_auth()
    };

    let mut server_config = builder
        .with_single_cert(certs, key)
        .context("failed to load SSL certificate and key")?;
    server_config.alpn_protocols = vec![b"http/1.1".to_vec()];

    Ok(TlsAcceptor::from(Arc::new(server_config)))
}

fn load_certs(path: &std::path::Path) -> Result<Vec<CertificateDer<'static>>> {
    let mut reader = BufReader::new(
        File::open(path).with_context(|| format!("failed to open {}", path.display()))?,
    );
    let certs = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| format!("failed to parse certificates in {}", path.display()))?;
    if certs.is_empty() {
        return Err(anyhow!("no certificates found in {}", path.display()));
    }
    Ok(certs)
}

fn load_private_key(path: &std::path::Path) -> Result<PrivateKeyDer<'static>> {
    let mut reader = BufReader::new(
        File::open(path).with_context(|| format!("failed to open {}", path.display()))?,
    );
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let mut reader = BufReader::new(bytes.as_slice());
    rustls_pemfile::private_key(&mut reader)
        .with_context(|| format!("failed to parse private key in {}", path.display()))?
        .ok_or_else(|| anyhow!("no private key found in {}", path.display()))
}
