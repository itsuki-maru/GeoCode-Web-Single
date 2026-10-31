//! 最小限の RESP2 テスト用サーバー。実際の redis::ConnectionManager が通信を行う。
//! GET/SETEX と接続の初期化のみをサポートし、エラーは明示的に発生させる。
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
};

#[derive(Default)]
pub struct CacheState {
    pub values: HashMap<Vec<u8>, Vec<u8>>,
    pub calls: Vec<Vec<Vec<u8>>>,
    pub fail_get: bool,
    pub fail_set: bool,
}
pub struct CacheFixture {
    pub state: Arc<Mutex<CacheState>>,
    pub connection: redis::aio::ConnectionManager,
    server: JoinHandle<()>,
}
impl CacheFixture {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(CacheState::default()));
        let shared = state.clone();
        let server = tokio::spawn(async move {
            let mut clients = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        clients.spawn(serve(stream, shared.clone()));
                    },
                    Some(result) = clients.join_next() => { result.unwrap(); },
                }
            }
        });
        let client = redis::Client::open(format!("redis://{address}/")).unwrap();
        let connection =
            tokio::time::timeout(Duration::from_secs(5), client.get_connection_manager())
                .await
                .unwrap()
                .unwrap();
        Self {
            state,
            connection,
            server,
        }
    }
}
impl Drop for CacheFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn command(reader: &mut BufReader<TcpStream>) -> Option<Vec<Vec<u8>>> {
    let mut line = String::new();
    if reader.read_line(&mut line).await.unwrap() == 0 {
        return None;
    }
    let length: usize = line.strip_prefix('*').unwrap().trim_end().parse().unwrap();
    let mut args = Vec::with_capacity(length);
    for _ in 0..length {
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        let size: usize = line.strip_prefix('$').unwrap().trim_end().parse().unwrap();
        let mut bytes = vec![0; size];
        reader.read_exact(&mut bytes).await.unwrap();
        let mut ending = [0; 2];
        reader.read_exact(&mut ending).await.unwrap();
        assert_eq!(&ending, b"\r\n");
        args.push(bytes);
    }
    Some(args)
}
async fn serve(stream: TcpStream, state: Arc<Mutex<CacheState>>) {
    let mut reader = BufReader::new(stream);
    while let Some(args) = command(&mut reader).await {
        let response = {
            let mut state = state.lock().unwrap();
            state.calls.push(args.clone());
            match args[0].as_slice() {
                b"CLIENT" | b"PING" => b"+OK\r\n".to_vec(),
                b"GET" if state.fail_get => b"-ERR injected GET failure\r\n".to_vec(),
                b"GET" => match state.values.get(&args[1]) {
                    Some(value) => {
                        let mut reply = format!("${}\r\n", value.len()).into_bytes();
                        reply.extend(value);
                        reply.extend(b"\r\n");
                        reply
                    },
                    None => b"$-1\r\n".to_vec(),
                },
                b"SETEX" if state.fail_set => b"-ERR injected SETEX failure\r\n".to_vec(),
                b"SETEX" => {
                    assert_eq!(args.len(), 4);
                    assert!(
                        std::str::from_utf8(&args[2])
                            .unwrap()
                            .parse::<u64>()
                            .unwrap()
                            > 0
                    );
                    state.values.insert(args[1].clone(), args[3].clone());
                    b"+OK\r\n".to_vec()
                },
                other => panic!(
                    "unsupported fixture command: {:?}",
                    String::from_utf8_lossy(other)
                ),
            }
        };
        reader.get_mut().write_all(&response).await.unwrap();
    }
}
