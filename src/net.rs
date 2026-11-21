use crate::model::{self, Config, Upstream};
use anyhow::{Context, Result, bail};
use axum_server::tls_rustls::RustlsConfig;
use base64::{Engine, engine::general_purpose::STANDARD};
use rcgen::{
    BasicConstraints, CertificateParams, GeneralSubtree, IsCa, Issuer, KeyPair, KeyUsagePurpose,
    NameConstraints,
};
use serde::{Deserialize, Serialize};
use std::{
    net::{Ipv4Addr, SocketAddr, TcpListener, UdpSocket},
    path::Path,
    time::Duration,
};

pub const SERVICE: &str = "_thoddrop2._tcp.local.";

pub fn default_address() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    match socket.local_addr().ok()? {
        SocketAddr::V4(addr) if addr.ip().is_private() => Some(*addr.ip()),
        _ => None,
    }
}

pub fn lan_listener(address: Ipv4Addr, port: u16) -> Result<TcpListener> {
    if !address.is_private() {
        bail!("Допустим только IPv4-адрес локальной сети (10…, 172.16–31… или 192.168…).")
    }
    let listener = TcpListener::bind((address, port)).with_context(|| {
        format!("Не удалось открыть {address}:{port}. Проверьте адрес и порт в настройках.")
    })?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

pub fn same_subnet(local: Ipv4Addr, remote: Ipv4Addr) -> bool {
    subnet_mask(local).is_some_and(|mask| in_subnet(local, remote, mask))
}

pub fn in_subnet(local: Ipv4Addr, remote: Ipv4Addr, mask: u32) -> bool {
    remote.is_private() && u32::from(local) & mask == u32::from(remote) & mask
}

pub fn subnet_mask(local: Ipv4Addr) -> Option<u32> {
    if_addrs::get_if_addrs().ok()?.iter().find_map(|interface| {
        let if_addrs::IfAddr::V4(addr) = &interface.addr else {
            return None;
        };
        let mask = u32::from(addr.netmask);
        (addr.ip == local && mask != 0).then_some(mask)
    })
}

#[derive(Default, Serialize, Deserialize)]
pub struct Authority {
    pub pem: String,
    #[serde(with = "crate::win::protected")]
    key: String,
}
impl Authority {
    pub fn der(&self) -> Result<Vec<u8>> {
        let encoded = self
            .pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>();
        STANDARD
            .decode(encoded)
            .context("Не удалось прочитать сертификат.")
    }

    pub fn fingerprint(&self) -> Result<String> {
        use sha2::{Digest, Sha256};
        Ok(Sha256::digest(self.der()?)
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(":"))
    }

    pub fn load(root: &Path) -> Result<Self> {
        let path = root.join("authority.json");
        let authority: Self = model::read(&path)?;
        if !authority.pem.is_empty() {
            return Ok(authority);
        }
        let mut params = CertificateParams::default();
        params.distinguished_name.push(
            rcgen::DnType::CommonName,
            format!(
                "ThodDrop {}",
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            ),
        );
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let mut private_names = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
            .into_iter()
            .map(|cidr| GeneralSubtree::IpAddress(cidr.parse().expect("private network")))
            .collect::<Vec<_>>();
        private_names.push(GeneralSubtree::DnsName(".thoddrop.invalid".try_into()?));
        params.name_constraints = Some(NameConstraints {
            permitted_subtrees: private_names,
            excluded_subtrees: Vec::new(),
        });
        let key = KeyPair::generate()?;
        let authority = Self {
            pem: params.self_signed(&key)?.pem(),
            key: key.serialize_pem(),
        };
        model::write(&path, &authority)?;
        Ok(authority)
    }

    pub async fn tls(&self, ip: Ipv4Addr) -> Result<RustlsConfig> {
        let issuer = Issuer::from_ca_cert_pem(&self.pem, KeyPair::from_pem(&self.key)?)?;
        let mut params = CertificateParams::new(vec![ip.to_string()])?;
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        let now = time::OffsetDateTime::now_utc();
        params.not_before = now - time::Duration::days(1);
        params.not_after = now + time::Duration::days(180);
        let key = KeyPair::generate()?;
        let chain = format!("{}{}", params.signed_by(&key, &issuer)?.pem(), self.pem);
        Ok(RustlsConfig::from_pem(chain.into_bytes(), key.serialize_pem().into_bytes()).await?)
    }
}

pub fn url(config: &Config) -> Option<String> {
    Some(format!("https://{}:{}", config.address?, config.port))
}

pub fn private_endpoint(url: &str) -> Result<Ipv4Addr> {
    let address = reqwest::Url::parse(url)?;
    let host: Ipv4Addr = address.host_str().unwrap_or_default().parse()?;
    let port = address.port_or_known_default().context("Укажите порт.")?;
    if !host.is_private() || url != format!("https://{host}:{port}") {
        bail!("Адрес ведущего компьютера должен быть локальным HTTPS-адресом.")
    }
    Ok(host)
}

pub fn peer_client(url: &str, ca: &str) -> Result<reqwest::Client> {
    private_endpoint(url)?;
    Ok(reqwest::Client::builder()
        .use_rustls_tls()
        .tls_built_in_root_certs(false)
        .add_root_certificate(reqwest::Certificate::from_pem(ca.as_bytes())?)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(4))
        .read_timeout(Duration::from_secs(30))
        .build()?)
}

pub fn peer_request(
    client: &reqwest::Client,
    upstream: &Upstream,
    method: reqwest::Method,
    path: &str,
) -> reqwest::RequestBuilder {
    client
        .request(method, format!("{}{path}", upstream.url))
        .bearer_auth(&upstream.token)
        .header("x-thoddrop", "1")
}
