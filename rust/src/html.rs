use std::io::Read;

use anyhow::{Context, Result};
use flate2::read::GzDecoder;

pub struct HtmlAssets {
    pub gzip: &'static [u8],
    pub plain: Vec<u8>,
}

impl HtmlAssets {
    pub fn load() -> Result<Self> {
        let gzip: &'static [u8] = include_bytes!(concat!(env!("OUT_DIR"), "/index.html.gz"));
        let mut decoder = GzDecoder::new(gzip);
        let mut plain = Vec::new();
        decoder
            .read_to_end(&mut plain)
            .context("failed to decompress embedded index.html.gz")?;
        Ok(Self { gzip, plain })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_the_frontend_asset() {
        let assets = HtmlAssets::load().unwrap();
        assert!(!assets.gzip.is_empty());
        let html = String::from_utf8(assets.plain).unwrap();
        assert!(html.starts_with("<!doctype html>") || html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains("terminal-container"));
    }
}
