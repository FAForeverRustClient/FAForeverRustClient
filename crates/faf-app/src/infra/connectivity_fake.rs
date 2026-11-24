//! The offline bundle's connectivity check (`infra::fake_ports`). In a file of
//! its own because the real check is not built on Android, and the offline
//! bundle is.

use std::net::SocketAddr;

use async_trait::async_trait;
use faf_domain::protocol::stun::{IceTransport, IceUrl};
use faf_domain::state::ProbeFailure;

use crate::ports::{
    AdapterInventory, AdapterLogTail, ConnectivityPort, JavaAdapterJar, JavaRuntimeInfo,
    KnownRelayAddresses, ProbeAnswer, RelayAddresses, RelayListError, RelayServer,
};

/// The offline check: every adapter present, two relays listed, both
/// answering. What `FAF_FAKE_AUTH=1` shows, so the view can be worked on
/// without a network; the addresses are from the documentation ranges.
pub struct FakeConnectivity;

#[async_trait]
impl ConnectivityPort for FakeConnectivity {
    async fn adapter_inventory(&self) -> AdapterInventory {
        AdapterInventory {
            forced: None,
            java_runtime: Ok(JavaRuntimeInfo {
                path: "natives/jre/bin/java".into(),
                version: Some("25.0.3".into()),
                major: Some(25),
            }),
            java_adapter: Some(JavaAdapterJar {
                path: "natives/java-ice-adapter/faf-ice-adapter.jar".into(),
                required_java: Some(21),
            }),
            pioneer: Some("natives/faf-pioneer".into()),
        }
    }

    async fn relay_list(&self) -> Result<Vec<RelayServer>, RelayListError> {
        Ok(vec![
            RelayServer {
                id: "1".into(),
                region: "Europe".into(),
            },
            RelayServer {
                id: "2".into(),
                region: "North America".into(),
            },
        ])
    }

    async fn relay_addresses(&self) -> KnownRelayAddresses {
        KnownRelayAddresses::Known(RelayAddresses {
            game_id: 1,
            urls: vec![
                "stun:relay.example.org".into(),
                "turn:relay.example.org?transport=tcp".into(),
            ],
        })
    }

    async fn probe(&self, url: &IceUrl) -> Result<ProbeAnswer, ProbeFailure> {
        Ok(match url.transport {
            IceTransport::Udp => ProbeAnswer::Binding {
                round_trip_ms: 24,
                public_address: Some(SocketAddr::from(([203, 0, 113, 7], 51_234))),
            },
            IceTransport::Tcp | IceTransport::Tls => ProbeAnswer::Connected { round_trip_ms: 31 },
        })
    }

    async fn adapter_log(&self) -> Option<AdapterLogTail> {
        None
    }
}
