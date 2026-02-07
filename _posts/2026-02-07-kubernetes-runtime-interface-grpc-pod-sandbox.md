---
layout: single
title: "Kubernetes 런타임 인터페이스: gRPC 통신과 Pod Sandbox의 역할"
date: 2026-02-07 14:00:00 +0900
categories: kubernetes
tags: [kubernetes, grpc, protobuf, http2, cri, pause-container, sandbox, container-runtime, namespace]
excerpt: "kubelet이 containerd와 통신할 때 왜 gRPC를 사용할까? Pod에 항상 존재하는 pause container는 정확히 어떤 역할을 할까? Kubernetes 런타임 레이어의 두 가지 핵심 기술인 gRPC와 Pod Sandbox를 HTTP/2 프로토콜 레벨부터 Linux 네임스페이스 수준까지 깊이 있게 살펴봅니다."
---

## 들어가며

[Kubernetes 리소스 생성 흐름](/kubernetes/kubernetes-resource-creation-flow)을 다룬 글에서 kubelet이 CRI를 통해 `RunPodSandbox → CreateContainer → StartContainer` 순서로 컨테이너를 생성한다고 했습니다. 그리고 CRI가 gRPC 인터페이스라는 것, pause container가 네트워크 네임스페이스를 소유한다는 것을 간단히 언급했습니다.

이 글에서는 그 두 가지를 깊이 있게 다룹니다. 먼저 gRPC가 왜 REST API 대신 선택되었는지 HTTP/2와 Protocol Buffers 레벨에서 살펴보고, 이어서 Pod Sandbox(pause container)가 Kubernetes Pod 모델에서 어떤 구조적 역할을 하는지 Linux 네임스페이스 수준까지 파고들겠습니다.

## gRPC — Kubernetes 내부 통신의 기반

### gRPC란?

gRPC는 Google이 개발한 고성능 RPC(Remote Procedure Call) 프레임워크입니다. 전통적인 REST API가 HTTP/1.1 + JSON 기반이라면, gRPC는 **HTTP/2 + Protocol Buffers(protobuf)** 기반으로 설계되었습니다.

```
REST API:
┌──────────┐  HTTP/1.1 + JSON   ┌──────────┐
│  Client  │ ──────────────────▶ │  Server  │
│          │ ◀────────────────── │          │
└──────────┘  텍스트 직렬화      └──────────┘

gRPC:
┌──────────┐  HTTP/2 + protobuf  ┌──────────┐
│  Client  │ ════════════════════ │  Server  │
│  (Stub)  │ ◀══════════════════ │          │
└──────────┘  바이너리 직렬화     └──────────┘
```

| 항목 | REST (HTTP/1.1 + JSON) | gRPC (HTTP/2 + protobuf) |
|-----|----------------------|-------------------------|
| 프로토콜 | HTTP/1.1 (텍스트) | HTTP/2 (바이너리 프레임) |
| 직렬화 | JSON (텍스트) | Protocol Buffers (바이너리) |
| 스키마 정의 | OpenAPI/Swagger (선택) | .proto 파일 (필수) |
| 코드 생성 | 선택 사항 | 자동 생성 (필수) |
| 스트리밍 | 제한적 (SSE, WebSocket) | 네이티브 양방향 스트리밍 |
| 페이로드 크기 | 큼 (키-값 텍스트) | 작음 (바이너리, ~3-10배 차이) |
| 브라우저 지원 | 네이티브 | 제한적 (gRPC-Web 필요) |

### HTTP/2가 핵심인 이유

gRPC의 성능 우위는 상당 부분 HTTP/2에서 옵니다.

```
HTTP/1.1:
┌──────────────────────────────────────────────┐
│  Connection 1: Request A → Response A        │
│  Connection 2: Request B → Response B        │  각 요청마다 연결 또는
│  Connection 3: Request C → Response C        │  순차 처리 (Head-of-Line blocking)
└──────────────────────────────────────────────┘

HTTP/2:
┌──────────────────────────────────────────────┐
│  Single Connection:                          │
│    Stream 1: Request A ←→ Response A         │
│    Stream 2: Request B ←→ Response B         │  하나의 연결에서
│    Stream 3: Request C ←→ Response C         │  다중 스트림 동시 처리
│                                              │
│  + Header Compression (HPACK)                │
│  + Server Push                               │
│  + Binary Framing                            │
└──────────────────────────────────────────────┘
```

**Multiplexing**: 하나의 TCP 연결에서 여러 요청/응답을 동시에 처리합니다. HTTP/1.1에서는 하나의 연결에서 요청을 보내면 응답이 올 때까지 다음 요청을 보낼 수 없는 Head-of-Line blocking 문제가 있었습니다. HTTP/2는 각 요청/응답을 독립적인 스트림으로 처리하여 이 문제를 해결합니다.

**Binary Framing**: HTTP/1.1은 텍스트 기반(`GET /path HTTP/1.1\r\n...`)이지만, HTTP/2는 바이너리 프레임으로 파싱이 빠르고 오류가 적습니다.

**Header Compression (HPACK)**: 반복되는 헤더를 압축합니다. Kubernetes 내부처럼 동일한 패턴의 요청이 반복되는 환경에서 네트워크 대역폭을 절약합니다.

kubelet이 containerd에 `CreateContainer`를 수백 번 호출할 때, HTTP/1.1이라면 매번 새 연결을 맺거나 순차 처리해야 하지만, HTTP/2에서는 하나의 연결에서 동시에 처리할 수 있습니다.

### Protocol Buffers (protobuf)

gRPC의 직렬화 포맷인 protobuf는 **스키마 정의 → 코드 자동 생성** 방식으로 동작합니다. Kubernetes CRI의 실제 `.proto` 정의를 보겠습니다.

```protobuf
// CRI의 .proto 정의 (핵심부 간략화)
syntax = "proto3";

service RuntimeService {
    rpc RunPodSandbox(RunPodSandboxRequest)
        returns (RunPodSandboxResponse) {}
    rpc CreateContainer(CreateContainerRequest)
        returns (CreateContainerResponse) {}
    rpc StartContainer(StartContainerRequest)
        returns (StartContainerResponse) {}
    rpc StopContainer(StopContainerRequest)
        returns (StopContainerResponse) {}
}

message RunPodSandboxRequest {
    PodSandboxConfig config = 1;     // 필드 번호 = 1
    string runtime_handler = 2;       // 필드 번호 = 2
}

message PodSandboxConfig {
    PodSandboxMetadata metadata = 1;
    string hostname = 2;
    string log_directory = 3;
    DNSConfig dns_config = 4;
    repeated PortMapping port_mappings = 5;
    LinuxPodSandboxConfig linux = 6;
}
```

이 `.proto` 파일에서 Go, Python, Java 등의 클라이언트/서버 코드가 자동 생성됩니다.

```
.proto 파일
    │
    ▼
protoc (컴파일러)
    │
    ├─ Go 코드 생성: runtime_service.pb.go
    │    - 구조체 (RunPodSandboxRequest 등)
    │    - 직렬화/역직렬화 메서드
    │    - 클라이언트 Stub
    │    - 서버 인터페이스
    │
    ├─ Python 코드 생성: runtime_service_pb2.py
    └─ Java 코드 생성: RuntimeService.java
```

#### protobuf 바이너리 직렬화

JSON과 protobuf의 직렬화 차이를 비교해보겠습니다.

```
JSON (텍스트, 58 bytes):
{"hostname":"pod-abc","logDirectory":"/var/log",
 "dnsConfig":{"servers":["10.96.0.10"]}}

protobuf (바이너리, ~23 bytes):
0a 07 70 6f 64 2d 61 62 63 12 08 2f 76 61 72
2f 6c 6f 67 22 05 0a 03 ...
```

protobuf는 필드 이름 대신 **필드 번호** 를 사용합니다. `.proto`의 `= 1`, `= 2`가 이 번호입니다. `hostname`이라는 9바이트 문자열 대신 1바이트 필드 번호로 인코딩하므로, 바이너리 크기가 JSON 대비 3~10배 작고, 파싱 속도도 빠릅니다.

필드 번호를 사용하는 것은 단순한 최적화가 아니라 **호환성** 측면에서도 중요합니다. 새 필드를 추가할 때 기존 번호를 건드리지 않으면 하위 호환이 자동으로 유지됩니다. kubelet과 containerd의 버전이 다르더라도, 서로 알지 못하는 필드는 무시하면 되므로 점진적 업그레이드가 가능합니다.

### gRPC 통신 패턴 4가지

gRPC는 네 가지 통신 패턴을 지원합니다.

```
1. Unary (단일 요청-응답):
   Client ──Request──▶ Server
   Client ◀──Response── Server

   예: kubelet → containerd: RunPodSandbox()

2. Server Streaming (서버 → 클라이언트 스트림):
   Client ──Request──▶ Server
   Client ◀──Response 1── Server
   Client ◀──Response 2── Server
   Client ◀──Response 3── Server

   예: API Server Watch (변경 이벤트 스트리밍)

3. Client Streaming (클라이언트 → 서버 스트림):
   Client ──Request 1──▶ Server
   Client ──Request 2──▶ Server
   Client ──Request 3──▶ Server
   Client ◀──Response── Server

4. Bidirectional Streaming (양방향):
   Client ════════════════ Server
   ◀──▶ 양방향 동시 스트리밍
```

Kubernetes에서 가장 중요한 패턴은 **Server Streaming** 입니다. 이전 글에서 다뤘던 API Server의 Watch 메커니즘이 바로 이 패턴입니다. Controller가 Watch 요청을 하나 보내면 API Server가 변경 이벤트를 연결이 유지되는 동안 계속 스트리밍합니다. HTTP/1.1 기반이었다면 Long Polling이나 WebSocket 같은 별도의 메커니즘이 필요했을 것입니다.

### Kubernetes에서의 gRPC 사용처

```
┌──────────────────────────────────────────────────────┐
│  Kubernetes 내부 gRPC 통신                            │
│                                                      │
│  kubelet ──gRPC──▶ containerd/CRI-O    (CRI)        │
│  kubelet ──gRPC──▶ CSI Driver           (CSI)        │
│  kubelet ──gRPC──▶ Device Plugin        (GPU 등)     │
│                                                      │
│  kube-apiserver ──gRPC──▶ etcd                       │
│  kube-apiserver ──gRPC──▶ Aggregated API Server      │
│                                                      │
│  istiod ──gRPC──▶ Envoy sidecar        (xDS API)    │
└──────────────────────────────────────────────────────┘
```

CRI, CSI, Device Plugin 같은 플러그인 인터페이스가 모두 gRPC로 정의된 이유는 **언어에 독립적인 인터페이스 정의** 가 가능하기 때문입니다. containerd는 Go로, 미래에 Rust로 구현된 런타임이 나와도 같은 `.proto` 인터페이스만 구현하면 kubelet과 즉시 호환됩니다. 인터페이스 정의와 구현이 완전히 분리되는 것입니다.

### CRI gRPC 통신 흐름 상세

이전 글에서 간단히 다뤘던 CRI 통신을 gRPC 레벨에서 보겠습니다.

```
kubelet                              containerd
  │                                       │
  │  gRPC: RunPodSandbox()               │
  │  (Unix Domain Socket:                │
  │   /run/containerd/containerd.sock)   │
  │──────────────────────────────────────▶│
  │                                       │ pause container 생성
  │                                       │ 네트워크 네임스페이스 설정
  │                                       │ CNI 호출
  │◀──────────────────────────────────────│
  │  Response: sandbox_id                 │
  │                                       │
  │  gRPC: CreateContainer()             │
  │  (sandbox_id + container config)     │
  │──────────────────────────────────────▶│
  │                                       │ 컨테이너 이미지 레이어 준비
  │                                       │ rootfs 마운트
  │◀──────────────────────────────────────│
  │  Response: container_id              │
  │                                       │
  │  gRPC: StartContainer()              │
  │  (container_id)                      │
  │──────────────────────────────────────▶│
  │                                       │ 프로세스 실행
  │◀──────────────────────────────────────│
  │  Response: success                   │
```

kubelet과 containerd는 TCP가 아닌 **Unix Domain Socket** 으로 통신합니다. 같은 노드의 프로세스 간 통신이므로 네트워크 스택을 탈 필요가 없고, 소켓 파일의 퍼미션으로 접근 제어가 가능합니다. gRPC는 TCP뿐 아니라 Unix Domain Socket도 트랜스포트로 사용할 수 있습니다.

## Pod Sandbox (pause container) — Pod의 인프라 기반

### Sandbox의 역할

Kubernetes에서 **Sandbox** 는 Pod의 격리 환경을 제공하는 인프라 컨테이너입니다. 실제 구현체가 **pause container** 이며, CRI 명세에서는 `PodSandbox`라는 추상화로 정의됩니다.

```
Pod 생성 시 가장 먼저 만들어지는 것:

kubelet → CRI: RunPodSandbox()
                    │
                    ▼
            ┌──────────────────┐
            │  pause container │
            │  (Sandbox)       │
            │                  │
            │  역할:           │
            │  1. 네트워크     │
            │     네임스페이스  │
            │     소유/유지     │
            │                  │
            │  2. PID 1로서    │
            │     좀비 프로세스 │
            │     reaping      │
            │                  │
            │  3. 다른 컨테이너│
            │     의 공유 기반 │
            └──────────────────┘
```

### pause container의 내부

pause container의 소스 코드는 놀랍도록 간단합니다.

```c
// Kubernetes pause container 소스 코드 (핵심부 간략화)
#include <signal.h>
#include <unistd.h>

static void sigdown(int signo) {
    _exit(0);
}

static void sigreap(int signo) {
    while (waitpid(-1, NULL, WNOHANG) > 0);  // 좀비 프로세스 정리
}

int main() {
    signal(SIGINT, sigdown);
    signal(SIGTERM, sigdown);
    signal(SIGCHLD, sigreap);  // 자식 프로세스 종료 시 정리

    for (;;)
        pause();  // 시그널 올 때까지 무한 대기

    return 0;
}
```

이것이 전부입니다. `pause()` 시스템 콜로 무한히 대기하면서 시그널만 처리합니다. 리소스를 거의 소비하지 않습니다(메모리 약 700KB). 핵심 기능은 **아무것도 하지 않고 존재하는 것** 자체입니다.

### Sandbox가 필요한 이유 1: 네트워크 네임스페이스의 안정적 소유자

Sandbox의 존재 이유 중 가장 핵심적인 것은 **네트워크 네임스페이스의 안정적 소유** 입니다.

만약 Sandbox 없이 앱 컨테이너가 네트워크 네임스페이스를 소유한다면 어떻게 될까요?

```
Sandbox 없는 경우 (문제):

Pod 시작:
  Container A 생성 → 네트워크 네임스페이스 소유
  Container B 생성 → A의 네임스페이스에 합류

Container A가 크래시:
  네트워크 네임스페이스 소멸! → Container B도 네트워크 단절
  Pod IP 상실 → 외부에서 접근 불가
```

```
Sandbox 있는 경우 (해결):

Pod 시작:
  pause container 생성 → 네트워크 네임스페이스 소유 (항상 존재)
  Container A 생성 → pause의 네임스페이스에 합류
  Container B 생성 → pause의 네임스페이스에 합류

Container A가 크래시 → 재시작:
  pause container 건재 → 네트워크 네임스페이스 유지
  Container B 영향 없음
  Container A 재시작 → 같은 네임스페이스에 다시 합류
  Pod IP 변경 없음!
```

앱 컨테이너가 아무리 크래시-재시작을 반복해도 **Pod의 네트워크 정체성(IP, 네트워크 네임스페이스)이 유지** 됩니다. 이것은 Kubernetes 네트워크 모델의 핵심 가정("Pod는 고유한 IP를 가진다")을 런타임 레벨에서 보장하는 메커니즘입니다.

### Sandbox가 필요한 이유 2: Linux 네임스페이스 공유의 기반

Linux 컨테이너는 여러 종류의 네임스페이스로 격리됩니다. pause container는 일부 네임스페이스를 소유하고 다른 컨테이너가 이를 공유합니다.

```
┌──────────────────────────────────────────────────┐
│  Pod                                             │
│                                                  │
│  pause container가 소유하는 네임스페이스:          │
│  ├─ Network namespace (eth0, IP, 포트 공간)      │
│  ├─ IPC namespace (공유 메모리, 세마포어)          │
│  └─ UTS namespace (hostname)                     │
│                                                  │
│  각 컨테이너가 독립적으로 유지하는 것:             │
│  ├─ PID namespace (프로세스 격리)                 │
│  ├─ Mount namespace (파일시스템)                  │
│  └─ User namespace (선택적)                      │
│                                                  │
│  Container A: pause의 net/ipc/uts에 합류         │
│  Container B: pause의 net/ipc/uts에 합류         │
│                                                  │
│  결과:                                           │
│  - A와 B는 같은 IP (localhost로 통신 가능)        │
│  - A와 B는 같은 hostname                         │
│  - A와 B는 IPC로 통신 가능                       │
│  - 하지만 파일시스템과 프로세스는 격리             │
└──────────────────────────────────────────────────┘
```

각 네임스페이스의 공유/격리 결정이 Pod의 동작을 결정합니다.

**Network namespace 공유**: 같은 Pod의 컨테이너끼리 `localhost`로 통신할 수 있습니다. Container A가 `:8080`에서 서비스하면 Container B가 `localhost:8080`으로 접근 가능합니다. 이것이 sidecar 패턴(예: Envoy proxy가 localhost를 통해 앱 트래픽을 가로채는 것)의 기반입니다.

**IPC namespace 공유**: 컨테이너 간 공유 메모리, 세마포어 등으로 고성능 프로세스 간 통신이 가능합니다.

**PID namespace 격리**: 기본적으로 각 컨테이너는 독립된 PID 공간을 가집니다. Container A의 프로세스 목록에 Container B의 프로세스가 보이지 않습니다. 단, Pod 스펙에서 `shareProcessNamespace: true`를 설정하면 PID 네임스페이스도 공유할 수 있습니다.

### Sandbox가 필요한 이유 3: PID 1과 좀비 프로세스 reaping

Linux에서 프로세스가 종료되면 부모 프로세스가 `wait()` 시스템 콜을 호출하여 종료 상태를 수거해야 합니다. 부모가 수거하지 않으면 커널이 프로세스 정보를 계속 유지하는데, 이것이 **좀비 프로세스** 입니다.

```
프로세스 트리:

pause (PID 1)
├── app-container (PID 2)
│   └── worker-thread (PID 3)  ← 이 프로세스의 부모(PID 2)가 먼저 종료되면
│                                  PID 3은 고아가 됨
└── sidecar (PID 4)

고아 프로세스 처리:
  worker-thread (PID 3)의 부모가 종료됨
  → Linux 커널이 PID 3의 부모를 PID 1 (pause)로 재지정
  → PID 3이 종료되면 pause가 waitpid()로 수거
  → 좀비 프로세스 방지
```

pause container의 `sigreap` 핸들러가 바로 이 역할을 합니다. `SIGCHLD` 시그널을 받으면 `waitpid(-1, NULL, WNOHANG)`을 호출하여 종료된 모든 자식 프로세스의 상태를 수거합니다.

일반 애플리케이션 프로세스는 자신이 생성한 자식 프로세스만 관리하고, 고아 프로세스의 수거까지 신경 쓰지 않는 경우가 많습니다. pause container가 PID 1로서 이 책임을 전담하므로 앱 컨테이너는 좀비 프로세스 관리를 걱정할 필요가 없습니다.

### Sandbox 생성의 전체 흐름

이전 글의 kubelet 섹션에서 간단히 다뤘던 흐름을 Sandbox 중심으로 더 상세하게 보겠습니다.

```
kubelet: Pod 스펙 수신
    │
    ▼
1. RunPodSandbox (CRI gRPC 호출)
    │
    ▼
containerd:
    ├─ pause 컨테이너 이미지 pull (registry.k8s.io/pause:3.9)
    ├─ 새 Linux 네임스페이스 생성:
    │    ├─ Network namespace
    │    ├─ IPC namespace
    │    └─ UTS namespace (hostname 설정)
    ├─ pause 프로세스 실행 (PID 1)
    └─ sandbox_id 반환
    │
    ▼
2. CNI 호출 (kubelet → CNI 플러그인)
    │
    ├─ 방금 생성된 Network namespace에 veth pair 연결
    ├─ Pod IP 할당 (IPAM)
    ├─ 라우팅 규칙 설정
    └─ 네트워크 준비 완료
    │
    ▼
3. CreateContainer (CRI gRPC, 앱 컨테이너)
    │
    ├─ sandbox_id를 전달하여 "이 Sandbox에 합류하라"고 지시
    ├─ containerd: 앱 컨테이너 생성
    │    ├─ pause의 Network namespace에 합류
    │    ├─ pause의 IPC namespace에 합류
    │    └─ 자체 PID, Mount namespace는 독립
    └─ container_id 반환
    │
    ▼
4. StartContainer (CRI gRPC)
    │
    └─ 앱 프로세스 실행
        → 이미 네트워크가 준비되어 있으므로 즉시 통신 가능
```

3단계에서 `sandbox_id`를 전달하는 것이 핵심입니다. 앱 컨테이너를 생성할 때 "새 네임스페이스를 만들어라"가 아니라 "이 Sandbox의 네임스페이스에 합류해라"고 지시합니다. 이 덕분에 여러 컨테이너가 동일한 네트워크 환경을 공유합니다.

### Sandbox와 Pod 라이프사이클

Sandbox는 Pod의 라이프사이클과 1:1로 매핑됩니다.

```
Pod 생성 → Sandbox 생성 → 앱 컨테이너들 생성/시작
    │
    │ (Pod 실행 중)
    │
    │ 앱 컨테이너 크래시 → kubelet이 재시작 (Sandbox 유지)
    │ 앱 컨테이너 크래시 → kubelet이 재시작 (Sandbox 유지)
    │ ...
    │
Pod 삭제 → 앱 컨테이너들 정지/삭제 → Sandbox 삭제
```

Sandbox가 삭제되는 것은 Pod가 완전히 종료될 때뿐입니다. 개별 앱 컨테이너의 재시작은 Sandbox에 영향을 주지 않습니다.

```bash
# 실행 중인 Pod의 pause container 확인
$ crictl pods
POD ID         CREATED       STATE   NAME              NAMESPACE
a1b2c3d4e5f6   5 hours ago   Ready   my-app-pod-xxx    production

# 해당 Pod의 컨테이너 목록 (pause + 앱 컨테이너)
$ crictl ps --pod a1b2c3d4e5f6
CONTAINER ID   IMAGE                    STATE    NAME
f1e2d3c4b5a6   registry.k8s.io/pause   Running  POD          # Sandbox
a6b5c4d3e2f1   my-app:latest           Running  my-app       # 앱 컨테이너
b7c6d5e4f3a2   envoy:latest            Running  envoy-proxy  # sidecar
```

`crictl`로 확인하면 `POD`라는 이름의 pause container가 항상 존재하는 것을 볼 수 있습니다.

## gRPC와 Sandbox의 관계

이 글에서 다룬 gRPC와 Sandbox는 독립적인 기술이지만, Kubernetes Pod 생성 과정에서 밀접하게 연결됩니다.

```
kubelet
    │
    │ ① gRPC: RunPodSandbox()
    │    → Sandbox(pause container) 생성
    │    → 네트워크 네임스페이스 확보
    │
    │ ② gRPC: CreateContainer()
    │    → sandbox_id 참조하여 네임스페이스 합류
    │
    │ ③ gRPC: StartContainer()
    │    → 앱 프로세스 실행
    │
    ▼
Pod 정상 동작
```

gRPC는 이 과정의 **통신 수단** 이고, Sandbox는 이 과정에서 생성되는 **인프라 기반** 입니다. gRPC의 `.proto`로 정의된 CRI 인터페이스 덕분에 kubelet은 containerd든 CRI-O든 어떤 런타임이든 동일한 방식으로 Sandbox를 생성하고 컨테이너를 관리할 수 있습니다.

## 정리

Kubernetes 런타임 레이어의 두 가지 핵심 기술을 정리하면 다음과 같습니다.

| 기술 | 역할 | 핵심 메커니즘 |
|-----|------|------------|
| **gRPC** | 컴포넌트 간 고성능 통신 | HTTP/2 멀티플렉싱 + protobuf 바이너리 직렬화 |
| **Pod Sandbox** | Pod 네트워크 정체성 유지 | pause container가 네임스페이스 소유, 앱 컨테이너가 합류 |

gRPC가 선택된 이유는 성능(HTTP/2 + protobuf)과 인터페이스 독립성(.proto 기반 코드 생성)이고, Sandbox가 존재하는 이유는 앱 컨테이너의 크래시와 무관하게 Pod의 네트워크 정체성을 안정적으로 유지하기 위함입니다. 두 기술 모두 Kubernetes가 "컨테이너 런타임에 독립적이면서 안정적인 Pod 추상화를 제공한다"는 설계 목표를 달성하는 데 핵심적인 역할을 합니다.
