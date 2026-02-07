---
layout: single
title: "Kubernetes 패킷 흐름: Pod 내부부터 멀티 클러스터까지"
date: 2026-02-07 12:00:00 +0900
categories: kubernetes
tags: [kubernetes, networking, cni, kube-proxy, iptables, ipvs, multi-cluster, transit-gateway, service-mesh, istio, ingress]
excerpt: "Kubernetes에서 패킷은 어떻게 흘러갈까? Pod 내부의 네트워크 네임스페이스부터 CNI의 Overlay/BGP 라우팅, kube-proxy의 DNAT, 그리고 Transit Gateway와 Service Mesh를 활용한 멀티 클러스터 패킷 흐름까지 전체 경로를 깊이 있게 살펴봅니다."
---

## 들어가며

"이 요청이 사용자 브라우저에서 출발해서 GPU 클러스터의 vLLM Pod에 도달하기까지 정확히 어떤 경로를 거치나요?"

멀티 클러스터 환경에서 장애가 발생했을 때 가장 먼저 해야 할 일은 패킷 경로를 추적하는 것입니다. 그런데 Kubernetes 네트워크는 여러 추상화 레이어가 겹쳐 있어서, 각 레이어에서 패킷이 어떻게 처리되는지 정확히 이해하지 못하면 문제의 원인을 찾기 어렵습니다.

이 글에서는 가장 작은 단위인 Pod 내부 통신부터 시작해서, 같은 노드의 Pod 간 통신, 다른 노드의 Pod 간 통신, Service를 통한 접근, 외부 트래픽 유입, 그리고 멀티 클러스터 환경까지 패킷이 흘러가는 전체 경로를 단계적으로 확장하며 살펴보겠습니다.

## Kubernetes 네트워크 모델의 기본 원칙

본격적인 패킷 흐름에 앞서, Kubernetes 공식 문서에서 정의하는 네트워크 모델의 핵심 요구사항을 짚고 넘어가겠습니다.

1. **모든 Pod는 NAT 없이 다른 모든 Pod와 통신** 할 수 있어야 한다
2. **모든 Node는 NAT 없이 모든 Pod와 통신** 할 수 있어야 한다
3. **Pod가 자신의 IP를 인식하는 것과 다른 Pod가 그 IP를 인식하는 것이 동일** 해야 한다

전통적인 Docker 네트워크에서는 호스트의 포트를 매핑(`-p 8080:80`)해야 컨테이너에 접근할 수 있었습니다. Kubernetes에서는 다릅니다. 모든 Pod가 고유한 IP를 가지고, 플랫한 네트워크에서 직접 통신합니다. 이 원칙을 구현하는 것이 CNI 플러그인의 역할입니다.

## Pod 내부 네트워크 구조

가장 작은 단위부터 보겠습니다. [이전 글](/kubernetes/2026/02/07/kubernetes-resource-creation-flow/)에서 kubelet이 CRI를 통해 `RunPodSandbox`를 먼저 실행한다고 했는데, 그 이유가 바로 네트워크 때문입니다.

```
┌───────────────────────────────────────────────────────┐
│  Pod (Network Namespace)                              │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │Container │  │Container │  │  pause   │            │
│  │   A      │  │   B      │  │container │            │
│  │          │  │          │  │(sandbox) │            │
│  │ :8080    │  │ :9090    │  │          │            │
│  └──────────┘  └──────────┘  └──────────┘            │
│       │              │              │                 │
│       └──────────────┴──────────────┘                 │
│                      │                                │
│                    eth0 (10.244.1.5)                   │
│                      │                                │
└──────────────────────┼────────────────────────────────┘
                       │
                   veth pair
                       │
              Host Network (Node)
```

**pause container가 네트워크 네임스페이스를 소유** 하고, 같은 Pod의 모든 컨테이너가 이 네임스페이스에 합류합니다. 그래서 Container A가 `localhost:9090`으로 Container B에 접근할 수 있는 것입니다. 포트만 다르면 같은 Pod 내 컨테이너 간 통신에는 어떤 네트워크 오버헤드도 없습니다.

## 같은 노드 내 Pod-to-Pod 통신

같은 노드에 있는 두 Pod가 통신하는 경로입니다.

```
┌───────────────────────────────────────────────────────────┐
│  Node 1                                                   │
│                                                           │
│  ┌─────────────┐              ┌─────────────┐            │
│  │   Pod A     │              │   Pod B     │            │
│  │ 10.244.1.5  │              │ 10.244.1.6  │            │
│  └──────┬──────┘              └──────┬──────┘            │
│         │ veth-a                      │ veth-b            │
│         │                             │                   │
│  ┌──────┴─────────────────────────────┴──────┐           │
│  │              cbr0 / cni0                   │           │
│  │          (Linux Bridge / vSwitch)          │           │
│  │              10.244.1.1                    │           │
│  └────────────────────┬──────────────────────┘           │
│                       │                                   │
│                    eth0 (Node IP: 192.168.1.10)           │
└───────────────────────┼───────────────────────────────────┘
```

패킷 흐름은 다음과 같습니다.

```
Pod A (10.244.1.5) → Pod B (10.244.1.6):

1. Pod A의 eth0에서 패킷 전송 (dst: 10.244.1.6)
2. veth pair를 통해 호스트의 veth-a로 전달
3. Linux Bridge(cbr0)가 MAC 테이블 조회
4. veth-b로 포워딩
5. Pod B의 eth0에 도달
```

L2 레벨에서 처리되므로 라우팅이 필요 없고 매우 빠릅니다. 커널의 네트워크 스택을 거치지만 물리 네트워크를 전혀 타지 않습니다.

## 다른 노드의 Pod-to-Pod 통신

다른 노드에 있는 Pod와 통신할 때가 CNI 플러그인의 역할이 본격적으로 중요해지는 지점입니다. CNI 플러그인별로 구현이 다르지만, 대표적인 두 가지 방식을 보겠습니다.

### Overlay 네트워크 (Flannel VXLAN, Calico IPIP)

```
┌──────────────┐                           ┌──────────────┐
│    Node 1    │                           │    Node 2    │
│              │                           │              │
│  Pod A       │                           │  Pod C       │
│  10.244.1.5  │                           │  10.244.2.3  │
│      │       │                           │      │       │
│   Bridge     │                           │   Bridge     │
│      │       │                           │      │       │
│  ┌───┴────┐  │                           │  ┌───┴────┐  │
│  │ VXLAN  │  │    Underlay Network       │  │ VXLAN  │  │
│  │ vtep   │──┼───── 192.168.1.0/24 ──────┼──│ vtep   │  │
│  └────────┘  │                           │  └────────┘  │
│ 192.168.1.10 │                           │ 192.168.1.11 │
└──────────────┘                           └──────────────┘
```

원본 패킷을 외부 UDP 패킷으로 **캡슐화(encapsulation)** 하여 노드 간 전송합니다.

```
패킷 구조 (VXLAN 캡슐화):
┌──────────────────────────────────────────────────────────┐
│ Outer Ethernet │ Outer IP          │ UDP    │ VXLAN     │
│ dst: Node2 MAC │ src: 192.168.1.10 │ :4789  │ VNI:1    │
│                │ dst: 192.168.1.11 │        │           │
├──────────────────────────────────────────────────────────┤
│ Inner Ethernet │ Inner IP          │ Payload            │
│                │ src: 10.244.1.5   │                    │
│                │ dst: 10.244.2.3   │                    │
└──────────────────────────────────────────────────────────┘
```

기존 네트워크 인프라를 변경하지 않아도 되는 장점이 있지만, 캡슐화/역캡슐화 오버헤드가 발생하고 MTU가 감소합니다(원래 1500에서 VXLAN 헤더 50바이트를 빼면 1450).

### Native Routing (Calico BGP, Cilium native)

```
┌──────────────┐                           ┌──────────────┐
│    Node 1    │                           │    Node 2    │
│              │                           │              │
│  Pod A       │                           │  Pod C       │
│  10.244.1.5  │                           │  10.244.2.3  │
│      │       │                           │      │       │
│   Bridge     │                           │   Bridge     │
│      │       │                           │      │       │
│  Routing     │                           │  Routing     │
│  Table:      │                           │  Table:      │
│  10.244.2.0/24│      BGP 피어링          │  10.244.1.0/24│
│  → 192.168.1.11    ◄────────────►       │  → 192.168.1.10│
│              │                           │              │
│ 192.168.1.10 │                           │ 192.168.1.11 │
└──────────────┘                           └──────────────┘
```

각 노드가 **BGP(Border Gateway Protocol)** 를 사용하여 Pod CIDR의 라우팅 정보를 교환합니다. 캡슐화 없이 표준 IP 라우팅으로 통신하므로 오버헤드가 적지만, 네트워크 인프라(ToR 스위치 등)가 BGP를 지원해야 합니다.

두 방식의 차이를 정리하면 다음과 같습니다.

| 방식 | 장점 | 단점 | 적합한 환경 |
|-----|------|------|-----------|
| Overlay (VXLAN) | 기존 네트워크 변경 불필요 | 캡슐화 오버헤드, MTU 감소 | 클라우드, 기존 인프라 |
| Native Routing (BGP) | 오버헤드 없음, 높은 성능 | 네트워크 인프라 BGP 지원 필요 | 온프레미스, 고성능 요구 |
| eBPF (Cilium) | 커널 레벨 최적화, 높은 관찰성 | 커널 버전 요구사항 | 대규모, 고성능 |

## Service 패킷 흐름 — kube-proxy의 역할

실제 애플리케이션은 Pod IP로 직접 통신하지 않습니다. Pod는 생성/삭제될 때마다 IP가 변경되므로, **Service** 라는 안정적인 추상화 레이어를 통해 접근합니다.

### ClusterIP Service의 패킷 흐름

```
┌──────────────────────────────────────────────────────────────┐
│  Client Pod (10.244.1.5)                                     │
│                                                              │
│  curl http://my-svc.default.svc.cluster.local:80             │
│       │                                                      │
│       ▼                                                      │
│  1. DNS 조회 (CoreDNS)                                       │
│     my-svc.default.svc.cluster.local → 10.96.0.100           │
│       │                                                      │
│       ▼                                                      │
│  2. 패킷 전송: dst = 10.96.0.100:80 (ClusterIP)             │
└───────┼──────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  Node의 Netfilter / eBPF                                     │
│                                                              │
│  3. kube-proxy가 설정한 규칙이 패킷을 가로챔                 │
│                                                              │
│  iptables 모드:                                              │
│    PREROUTING → KUBE-SERVICES                                │
│    → KUBE-SVC-XXXX (Service 매칭)                            │
│    → KUBE-SEP-YYYY (Endpoint 선택, DNAT)                     │
│                                                              │
│  IPVS 모드:                                                  │
│    Virtual Server: 10.96.0.100:80                            │
│    → Real Server: 10.244.1.10:8080 (weight: 1)              │
│    → Real Server: 10.244.2.20:8080 (weight: 1)              │
│    → Real Server: 10.244.3.30:8080 (weight: 1)              │
│                                                              │
│  4. DNAT: dst 변환                                           │
│     10.96.0.100:80 → 10.244.2.20:8080                       │
└───────┼──────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  5. 실제 Pod로 패킷 전달                                     │
│     (같은 노드면 Bridge, 다른 노드면 CNI 경로)               │
│                                                              │
│  Backend Pod (10.244.2.20:8080)                               │
└──────────────────────────────────────────────────────────────┘
```

핵심은 **ClusterIP(10.96.0.100)는 가상 IP** 라는 것입니다. 어떤 네트워크 인터페이스에도 바인딩되지 않으며, 오직 각 노드의 iptables/IPVS 규칙에 의해 DNAT(Destination NAT)으로 실제 Pod IP로 변환됩니다.

### iptables vs IPVS

| 항목 | iptables | IPVS |
|-----|---------|------|
| 탐색 복잡도 | O(n) 체인 순회 | O(1) 해시 테이블 |
| 로드밸런싱 | random (확률 기반) | rr, lc, wrr, sh 등 |
| Service 1000개 성능 | 눈에 띄는 지연 | 영향 미미 |
| 디버깅 | `iptables -t nat -L` | `ipvsadm -Ln` |

대규모 클러스터에서 Service와 Endpoint 수가 많아지면 iptables의 O(n) 체인 순회가 성능 병목이 됩니다. IPVS는 해시 테이블 기반이므로 규모에 관계없이 일정한 성능을 유지합니다.

### kube-proxy의 규칙 업데이트

kube-proxy도 [이전 글](/kubernetes/2026/02/07/kubernetes-resource-creation-flow/)에서 다뤘던 Informer 패턴으로 동작합니다. Service, Endpoints, EndpointSlice 리소스를 Watch하다가 변경이 감지되면 iptables/IPVS 규칙을 업데이트합니다. Pod가 Ready 상태가 되어 Endpoint에 등록되면 kube-proxy가 이를 감지하여 해당 Pod로 트래픽이 라우팅되기 시작하고, Pod가 제거되면 규칙에서 빠집니다.

## 외부 트래픽 유입 — NodePort, LoadBalancer, Ingress

외부에서 클러스터 내부로 트래픽이 유입되는 경로를 보겠습니다. 세 가지 Service 타입이 계층적으로 쌓이는 구조입니다.

```
인터넷 사용자
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  External Load Balancer (L4)                         │
│  (AWS NLB/ALB, 온프레미스 F5, MetalLB 등)            │
│  공인 IP: 203.0.113.10                               │
└────────────────────┬─────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────┐
│  NodePort (모든 노드의 30000-32767 포트)              │
│                                                      │
│  Node 1:30080  ←─┐                                   │
│  Node 2:30080  ←─┼── LB가 분배                       │
│  Node 3:30080  ←─┘                                   │
└────────────────────┬─────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────┐
│  Ingress Controller Pod (nginx, envoy 등)            │
│                                                      │
│  L7 라우팅:                                          │
│  - Host: api.example.com → Service A                 │
│  - Path: /v1/* → Service A                           │
│  - Path: /v2/* → Service B                           │
│  - TLS Termination                                   │
└────────────────────┬─────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────┐
│  ClusterIP Service → Pod                             │
│  (위의 Service 패킷 흐름과 동일)                      │
└──────────────────────────────────────────────────────┘
```

### externalTrafficPolicy의 영향

`externalTrafficPolicy` 설정에 따라 패킷 경로가 크게 달라집니다. 이 설정은 성능과 가용성의 트레이드오프입니다.

**Cluster 모드 (기본값)** 에서는 트래픽이 어떤 노드에 도착하든 클러스터 전체의 Pod로 분배됩니다. 다른 노드로 포워딩될 수 있어 추가 홉이 발생하고, 이 과정에서 Source IP가 노드 IP로 SNAT되어 원본 클라이언트 IP를 잃습니다.

**Local 모드** 에서는 트래픽이 도착한 노드에 해당 Pod가 있을 때만 전달합니다. 추가 홉이 없고 Source IP가 보존되지만, Pod가 없는 노드로 트래픽이 도착하면 드롭됩니다.

| 항목 | Cluster | Local |
|-----|---------|-------|
| Source IP 보존 | ❌ SNAT됨 | ✅ 보존 |
| 부하 분산 | 균등 | 불균등 (Pod 분포에 따라) |
| 추가 홉 | 발생 가능 | 없음 |
| 가용성 | 어느 노드든 응답 | Pod가 있는 노드만 |

클라이언트 IP 기반 감사 로그가 필요한 경우 Local 모드를 선택해야 합니다.

## 멀티 클러스터 네트워크 아키텍처

여기서부터 멀티 클러스터 환경으로 확장합니다. 멀티 클러스터가 필요한 이유는 환경 분리(Dev/Staging/Prod), 지역 분산, 팀/기능별 분리, 장애 격리, 규제 준수 등 다양합니다.

멀티 클러스터 간 네트워크를 연결하는 방식은 크게 세 가지 계층으로 나눌 수 있습니다.

```
┌──────────────────────────────────────────────────────────┐
│  Layer 1: 네트워크 연결 (인프라 레벨)                     │
│  - VPC Peering / Transit Gateway / VPN / 전용선           │
│  - 클러스터 간 네트워크 도달성 확보                        │
├──────────────────────────────────────────────────────────┤
│  Layer 2: 서비스 디스커버리 (플랫폼 레벨)                 │
│  - 다른 클러스터의 서비스를 어떻게 발견하는가              │
│  - DNS 기반 / Service Mesh / API Gateway                  │
├──────────────────────────────────────────────────────────┤
│  Layer 3: 트래픽 관리 (애플리케이션 레벨)                 │
│  - 로드밸런싱, 페일오버, 라우팅 정책                      │
│  - Global Load Balancer / Service Mesh 정책               │
└──────────────────────────────────────────────────────────┘
```

실무에서는 이 계층들을 조합하여 사용합니다. 대표적인 패턴 네 가지를 순서대로 살펴보겠습니다.

## 패턴 1: API Gateway 기반 (L7 라우팅)

가장 단순하고 클러스터 간 독립성이 높은 패턴입니다.

```
                        Internet
                           │
                           ▼
                ┌──────────────────┐
                │  Global Load     │
                │  Balancer        │
                │  (AWS ALB /      │
                │   Cloudflare /   │
                │   NGINX Plus)    │
                └────────┬─────────┘
                         │
              ┌──────────┼──────────┐
              ▼                     ▼
┌─────────────────────┐  ┌─────────────────────┐
│  Cluster A (Seoul)  │  │  Cluster B (Tokyo)  │
│                     │  │                     │
│  ┌───────────────┐  │  │  ┌───────────────┐  │
│  │Ingress        │  │  │  │Ingress        │  │
│  │Controller     │  │  │  │Controller     │  │
│  └───────┬───────┘  │  │  └───────┬───────┘  │
│          │          │  │          │          │
│  ┌───────▼───────┐  │  │  ┌───────▼───────┐  │
│  │  Service A    │  │  │  │  Service A    │  │
│  │  (ClusterIP)  │  │  │  │  (ClusterIP)  │  │
│  └───────┬───────┘  │  │  └───────┬───────┘  │
│          │          │  │          │          │
│  ┌───────▼───────┐  │  │  ┌───────▼───────┐  │
│  │  Pod Pod Pod  │  │  │  │  Pod Pod Pod  │  │
│  └───────────────┘  │  │  └───────────────┘  │
└─────────────────────┘  └─────────────────────┘
```

각 클러스터는 독립적인 네트워크를 유지합니다. Global Load Balancer가 Geo-routing이나 헬스체크 기반으로 클러스터 단위로 트래픽을 분배하고, 각 클러스터 내부에서는 일반적인 Service 패킷 흐름을 따릅니다. Pod CIDR이 겹쳐도 문제없다는 것이 큰 장점이지만, 클러스터 간 직접 Pod-to-Pod 통신은 불가능합니다.

## 패턴 2: Transit Gateway + Internal LB (VPC 간 연결)

클러스터 간 Pod가 직접 통신하거나, 다른 VPC의 서비스를 호출해야 하는 경우입니다.

### 인프라 레벨 연결 (AWS 기준)

```
┌──────────────────────────────────────────────────────────────┐
│                      AWS Transit Gateway                      │
│                                                              │
│  ┌──────────────────────┐    ┌──────────────────────┐       │
│  │  VPC A               │    │  VPC B               │       │
│  │  CIDR: 10.0.0.0/16  │    │  CIDR: 10.1.0.0/16  │       │
│  │                      │    │                      │       │
│  │  ┌────────────────┐  │    │  ┌────────────────┐  │       │
│  │  │ EKS Cluster A  │  │    │  │ EKS Cluster B  │  │       │
│  │  │                │  │    │  │                │  │       │
│  │  │ Node CIDR:     │  │    │  │ Node CIDR:     │  │       │
│  │  │ 10.0.1.0/24    │  │    │  │ 10.1.1.0/24    │  │       │
│  │  │                │  │    │  │                │  │       │
│  │  │ Pod CIDR:      │  │    │  │ Pod CIDR:      │  │       │
│  │  │ 10.0.64.0/18   │  │    │  │ 10.1.64.0/18   │  │       │
│  │  └────────────────┘  │    │  └────────────────┘  │       │
│  │                      │    │                      │       │
│  │  TGW Attachment ─────┼────┼──── TGW Attachment   │       │
│  └──────────────────────┘    └──────────────────────┘       │
│                                                              │
│  Route Tables:                                               │
│  10.0.0.0/16 → VPC A attachment                              │
│  10.1.0.0/16 → VPC B attachment                              │
│  10.0.64.0/18 → VPC A attachment  (Pod CIDR)                 │
│  10.1.64.0/18 → VPC B attachment  (Pod CIDR)                 │
└──────────────────────────────────────────────────────────────┘
```

**핵심 요구사항**: Transit Gateway가 IP 라우팅 기반으로 동작하므로, 각 클러스터의 VPC CIDR과 Pod CIDR이 모두 **겹치면 안 됩니다**. 이 CIDR 계획이 멀티 클러스터 설계에서 가장 먼저 해야 할 일입니다.

### 클러스터 간 통신 패킷 흐름

```
Cluster A의 Pod (10.0.64.5) → Cluster B의 Pod (10.1.64.10)

① Pod A에서 패킷 전송
   src: 10.0.64.5, dst: 10.1.64.10

② CNI: 목적지가 로컬 Pod CIDR이 아님
   → 노드의 기본 라우팅 테이블로 전달

③ Node의 라우팅 테이블:
   10.1.0.0/16 → VPC Router (default gateway)

④ VPC Router → Transit Gateway
   TGW 라우팅: 10.1.64.0/18 → VPC B attachment

⑤ Transit Gateway → VPC B Router

⑥ VPC B Router → Cluster B Node
   (AWS VPC CNI: Pod IP가 ENI의 Secondary IP로 직접 할당)

⑦ Cluster B Node → Pod (10.1.64.10)
```

AWS EKS에서 VPC CNI를 사용하면 Pod IP가 VPC의 실제 IP 대역에서 할당되므로, Transit Gateway가 Pod IP를 직접 라우팅할 수 있습니다. 이것이 AWS 환경에서 멀티 클러스터 통신이 비교적 단순한 이유입니다.

실무에서 가장 일반적인 방식은 **직접 Pod 라우팅 대신 Internal LoadBalancer를 경유** 하는 것입니다.

```yaml
# Cluster B에서 서비스를 Internal NLB로 노출
apiVersion: v1
kind: Service
metadata:
  name: llm-inference
  namespace: ai
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-internal: "true"
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
spec:
  type: LoadBalancer
  ports:
  - port: 8000
    targetPort: 8000
  selector:
    app: vllm
```

```
Cluster A Pod → Internal NLB (10.1.0.50:8000) → Cluster B Node → vLLM Pod
```

이 방식이 선호되는 이유는 Pod CIDR 라우팅 설정이 불필요하고, NLB가 헬스체크와 로드밸런싱을 제공하며, Security Group으로 접근 제어가 가능하기 때문입니다.

## 패턴 3: Service Mesh 기반 멀티 클러스터 (Istio)

Service Mesh를 사용하면 서비스 레벨에서 멀티 클러스터 통신을 투명하게 추상화할 수 있습니다.

### Istio Multi-Primary 아키텍처

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  ┌─────────────────────┐    ┌──────────────────────┐        │
│  │  Cluster A          │    │  Cluster B           │        │
│  │                     │    │                      │        │
│  │  ┌───────────────┐  │    │  ┌───────────────┐   │        │
│  │  │    istiod A    │  │    │  │    istiod B    │   │        │
│  │  └───────┬───────┘  │    │  └───────┬───────┘   │        │
│  │          │          │    │          │           │        │
│  │  각자의 Envoy 관리  │    │  각자의 Envoy 관리   │        │
│  │                     │    │                      │        │
│  │  Remote Secret ─────┼────┼───► Cluster B의      │        │
│  │  (Cluster B의       │    │     API Server       │        │
│  │   kubeconfig)       │    │     접근 가능         │        │
│  │                     │    │                      │        │
│  │  East-West Gateway ─┼────┼── East-West Gateway  │        │
│  └─────────────────────┘    └──────────────────────┘        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

각 클러스터의 istiod는 **Remote Secret** 을 통해 상대 클러스터의 API Server에 접근하고, Service/Endpoint 정보를 Watch합니다. 이렇게 수집된 정보를 통합 Service Registry에 병합하여, Envoy sidecar에게 모든 클러스터의 endpoint 정보를 제공합니다.

### East-West Gateway를 통한 패킷 흐름

네트워크가 직접 연결되지 않은 경우, East-West Gateway가 클러스터 간 트래픽을 중계합니다.

```
Cluster A의 Service X → Cluster B의 Service Y 호출

┌─ Cluster A ──────────────────────────────────────────┐
│                                                      │
│  Pod (Service X)                                     │
│    │                                                 │
│    │ ① App: "http://service-y.ns.svc.cluster.local" │
│    ▼                                                 │
│  Envoy Sidecar                                       │
│    │                                                 │
│    │ ② istiod에서 받은 설정 확인:                     │
│    │    "service-y는 Cluster B에 endpoint가 있음"     │
│    │    "Cluster B의 East-West Gateway로 전송"        │
│    │                                                 │
│    │ ③ mTLS 암호화 + SNI 헤더 설정                   │
│    ▼                                                 │
│  East-West Gateway                                   │
│    │                                                 │
│    │ ④ 외부로 패킷 전송 (LoadBalancer Service)       │
└────┼─────────────────────────────────────────────────┘
     │
     │  ⑤ 네트워크 전송 (Transit Gateway / VPN / Internet)
     │
┌────┼─────────────────────────────────────────────────┐
│    ▼                                                 │
│  East-West Gateway (Cluster B)                       │
│    │                                                 │
│    │ ⑥ SNI 기반 라우팅:                              │
│    │    SNI 헤더에서 목적지 서비스 파악                │
│    ▼                                                 │
│  Envoy Sidecar (Service Y의 Pod)                     │
│    │                                                 │
│    │ ⑦ mTLS 검증 + 복호화                            │
│    ▼                                                 │
│  Pod (Service Y) → 요청 처리                          │
└──────────────────────────────────────────────────────┘
```

East-West Gateway는 TLS의 **SNI(Server Name Indication) 헤더** 를 사용하여, 단일 게이트웨이 엔드포인트에서 여러 서비스로의 트래픽을 라우팅합니다. 패킷을 복호화하지 않고 SNI만 확인하므로 mTLS가 end-to-end로 유지됩니다.

Istio는 **Locality-aware Load Balancing** 도 지원하여, 같은 Zone의 Pod를 우선 사용하고, 장애 시에만 다른 Region의 Pod로 페일오버합니다.

## 패턴 4: DMZ + 서브넷 분리 + Transit Gateway 하이브리드

패턴 1~3은 개별적으로 사용되기보다 실무에서는 조합하여 사용하는 경우가 많습니다. 엔터프라이즈 환경에서 흔히 볼 수 있는 실제 프로덕션 아키텍처를 보겠습니다.

### 전체 아키텍처

```
                         Internet
                            │
┌───────────────────────────┼──────────────────────────────────┐
│  DMZ Zone                 │                                  │
│                           ▼                                  │
│                    ┌─────────────┐                            │
│                    │    WAF      │  (L7 보안: SQL Injection,  │
│                    │             │   XSS, Bot 탐지 등)       │
│                    └──────┬──────┘                            │
│                           │                                  │
│                    ┌──────▼──────┐                            │
│                    │  전용 LB    │  (L4/L7, 공인 IP 보유)     │
│                    │  (DMZ용)    │  진입점 역할               │
│                    └──────┬──────┘                            │
└───────────────────────────┼──────────────────────────────────┘
                            │
┌───────────────────────────┼──────────────────────────────────────────┐
│  VPC A (메인)             │                                          │
│                           │                                          │
│  ┌────────────────────────┼────────────────────────────────────┐     │
│  │Subnet 1 (Web)          ▼                                   │     │
│  │              ┌──────────────┐  ┌──────────────────────┐    │     │
│  │              │  L4 LB ①    │─▶│ ingress-nginx-ctrl   │    │     │
│  │              └──────────────┘  │ (Cluster 1: Web)     │    │     │
│  │                                └──────────┬───────────┘    │     │
│  │                                       Web Pods             │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │Subnet 2 (WAS)                                              │     │
│  │              ┌──────────────┐  ┌──────────────────────┐    │     │
│  │              │  L4 LB ②    │─▶│ ingress-nginx-ctrl   │    │     │
│  │              └──────────────┘  │ (Cluster 2: WAS)     │    │     │
│  │                                └──────────┬───────────┘    │     │
│  │                                       WAS Pods             │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │Subnet 3 (AI 서비스)                                        │     │
│  │              ┌──────────────┐  ┌──────────────────────┐    │     │
│  │              │  L4 LB ③    │─▶│ ingress-nginx-ctrl   │    │     │
│  │              └──────────────┘  │ (Cluster 3: AI App)  │    │     │
│  │                                └──────────┬───────────┘    │     │
│  │                                      AI App Pods           │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │Subnet 4~8 (Infra, Monitoring, 기타 ...)                    │     │
│  │              각각 L4 LB + ingress-nginx-controller          │     │
│  └────────────────────────────────────────────────────────────┘     │
│                                                                      │
│                   서브넷 간: VPC 내부 라우팅 (직접 통신)               │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                        Transit Gateway
                               │
┌──────────────────────────────┴───────────────────────────────────────┐
│  VPC B (GPU 전용)                                                     │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │              ┌──────────────┐  ┌──────────────────────┐    │      │
│  │              │ L4 LB (내부) │─▶│ GPU Cluster          │    │      │
│  │              └──────────────┘  │ (B200 Farm)          │    │      │
│  │                                │ vLLM 추론 서버       │    │      │
│  │                                └──────────────────────┘    │      │
│  └────────────────────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────────────────────┘
```

이 구조는 업계에서 **Hub-and-Spoke 토폴로지** 위에 **Zone-based Security Architecture** 를 결합한 형태로 분류됩니다.

- **DMZ Zone**: WAF + 전용 LB가 공인망 접점 역할 (Hub)
- **Service Zone**: 기능별로 분리된 8개 클러스터가 각 서브넷에 배치 (Spoke)
- **GPU Zone**: 추론 전용 클러스터가 별도 VPC에 격리 (격리된 Spoke)

### 핵심 패킷 흐름: 사용자 → LLM 추론

이 아키텍처에서 사용자의 AI 서비스 요청이 GPU 클러스터까지 도달하는 전체 경로입니다.

```
사용자 (인터넷)
    │
    │ ① HTTPS: api.example.com/v1/chat
    ▼
DMZ - WAF
    │ ② 악성 요청 필터링 (L7 검사, 패턴 매칭)
    ▼
DMZ - 전용 LB
    │ ③ L4/L7 라우팅 → VPC A의 Subnet 1 LB로 전달
    ▼
VPC A - Subnet 1 - L4 LB ①
    │ ④ L4 로드밸런싱 → ingress-nginx-controller Pod
    ▼
Cluster 1 - ingress-nginx-controller
    │ ⑤ L7 라우팅: Host/Path → ClusterIP Service → Web Pod
    ▼
Web Pod
    │ ⑥ WAS 클러스터 API 호출
    │    dst: L4 LB ② 주소 (같은 VPC, 서브넷 간 라우팅)
    │
    │    패킷: Pod → Node → VPC Router → Subnet 2
    │    → L4 LB ② → Cluster 2 Ingress → WAS Pod
    ▼
WAS Pod
    │ ⑦ GPU 클러스터 추론 호출
    │    dst: GPU Cluster Internal LB 주소
    │
    │    패킷: Pod → Node → VPC A Router
    │    → Transit Gateway (VPC 간 라우팅)
    │    → VPC B Router → GPU Node → vLLM Pod
    ▼
GPU Cluster - vLLM Pod
    │ ⑧ 추론 실행, 스트리밍 응답 (SSE)
    │    (역경로로 응답 반환)
    ▼
... → WAS → Web → Ingress → LB → DMZ LB → WAF → 사용자
```

### 클러스터 간 통신 경로의 특성

**VPC A 내부 (서브넷 간)**: 같은 VPC이므로 Transit Gateway가 필요 없습니다. VPC Router가 서브넷 간 라우팅을 직접 처리합니다. 하지만 각 클러스터가 독립적인 LB를 가지고 있으므로, Pod-to-Pod 직접 통신이 아니라 **LB → Ingress** 경로를 타게 됩니다.

```
클러스터 간 통신 경로:

직접 통신 (X):  Cluster 1 Pod → Cluster 2 Pod
실제 경로 (O):  Cluster 1 Pod → L4 LB ② → Cluster 2 Ingress → Pod

이유: 보안 경계 유지 + 각 클러스터의 독립성 보장
```

이것은 의도된 설계입니다. 각 클러스터의 진입점(LB + Ingress)을 강제함으로써 접근 제어, 트래픽 모니터링, 장애 격리가 가능합니다. 특정 클러스터에 문제가 생겨도 해당 LB만 영향을 받고 다른 클러스터는 정상 동작합니다.

**VPC A → VPC B (Transit Gateway 경유)**: GPU 클러스터를 별도 VPC에 둔 이유는 비용 관리(고가의 GPU 노드 격리), 보안 격리(추론 서비스 접근 제한), 네트워크 대역폭 분리(대용량 텐서 전송 트래픽 격리) 목적입니다. Transit Gateway를 통해 연결하되, Security Group으로 VPC A의 특정 서브넷에서만 GPU 클러스터에 접근할 수 있도록 제한합니다.

### 모니터링 흐름

이 아키텍처에서 모니터링 메트릭 수집도 네트워크 경로를 따릅니다.

```
각 클러스터의 Prometheus (로컬 수집)
    │
    │ Remote Write (VPC 내부 라우팅)
    ▼
Monitoring Cluster (Subnet N)의 Thanos Receive
    │
    │ Thanos Store → Thanos Query
    ▼
Grafana 대시보드

GPU Cluster의 Prometheus
    │
    │ Remote Write (Transit Gateway 경유)
    ▼
Monitoring Cluster의 Thanos Receive
```

## 멀티 클러스터 네트워크 설계 핵심 고려사항

### CIDR 계획

멀티 클러스터에서 가장 먼저 해야 할 것은 IP 대역 충돌 방지입니다.

```
# CIDR 계획 예시

VPC CIDR:
  VPC A (메인): 10.0.0.0/16
  VPC B (GPU): 10.1.0.0/16

Node Subnet (VPC A 내):
  Subnet 1 (Web):   10.0.1.0/24
  Subnet 2 (WAS):   10.0.2.0/24
  Subnet 3 (AI):    10.0.3.0/24
  ...

Pod CIDR:
  Cluster 1: 10.0.64.0/18   (16,384 IPs)
  Cluster 2: 10.0.128.0/18
  Cluster 3: 10.0.192.0/18
  ...
  GPU Cluster: 10.1.64.0/18

Service CIDR:
  각 클러스터별로 분리 (172.20.0.0/16, 172.21.0.0/16, ...)
  (ClusterIP는 클러스터 내부용이므로 겹쳐도 되지만, 구분 권장)
```

### 보안 — 계층별 방어

```
┌──────────────────────────────────────────────────────────┐
│  Network Level:                                          │
│  - Security Group: 클러스터 간 필요한 포트만 허용        │
│  - Network Policy: Pod 레벨 트래픽 제어                  │
│  - TGW Route Table: 허용된 CIDR만 라우팅                 │
│                                                          │
│  Transport Level:                                        │
│  - mTLS: 서비스 간 상호 인증 + 암호화 (Istio)           │
│  - TLS: 최소한 전송 암호화                               │
│                                                          │
│  Application Level:                                      │
│  - API Key / JWT: 서비스 인증                            │
│  - Authorization Policy: L7 접근 제어                    │
└──────────────────────────────────────────────────────────┘
```

### DNS 전략

```
클러스터 내부 DNS (CoreDNS):
  service-a.ns.svc.cluster.local → ClusterIP

클러스터 간 DNS 옵션:
  1. External DNS + Route53:
     service-a.cluster-a.internal.example.com → Internal NLB IP

  2. CoreDNS Forward:
     *.cluster-b.local → Cluster B의 CoreDNS로 포워딩

  3. Service Mesh:
     동일한 서비스 이름으로 투명하게 라우팅
```

## 정리

Kubernetes의 패킷 흐름을 Pod 내부부터 멀티 클러스터까지 확장하며 살펴보았습니다.

| 레벨 | 핵심 메커니즘 | 주요 컴포넌트 |
|-----|------------|-------------|
| Pod 내부 | 공유 네트워크 네임스페이스 | pause container, localhost 통신 |
| 같은 노드 Pod 간 | Linux Bridge (L2) | veth pair, cbr0/cni0 |
| 다른 노드 Pod 간 | CNI 플러그인 (Overlay/BGP) | VXLAN, Calico BGP, Cilium eBPF |
| Service 접근 | DNAT (iptables/IPVS) | kube-proxy, ClusterIP |
| 외부 유입 | NodePort + LB + Ingress | Ingress Controller, L7 라우팅 |
| 멀티 클러스터 | TGW + LB 또는 Service Mesh | VPC Peering, Istio East-West GW |

멀티 클러스터 연결 패턴의 선택 기준도 정리합니다.

| 패턴 | 복잡도 | Pod 직접 통신 | 적합한 환경 |
|-----|-------|-------------|-----------|
| API Gateway 기반 | 낮음 | ❌ | 독립적인 서비스, CIDR 겹침 허용 |
| Transit GW + Internal LB | 중간 | △ (LB 경유) | AWS 멀티 클러스터 일반적 구성 |
| Service Mesh (Istio) | 높음 | ✅ (투명) | 복잡한 서비스 간 통신, mTLS 필수 |
| DMZ + 서브넷 분리 + TGW | 중간 | LB 경유 | 엔터프라이즈, 보안 경계 필수 환경 |

패킷 흐름의 각 단계를 이해하고 있으면 장애 시 문제가 어느 구간에서 발생했는지 빠르게 좁혀갈 수 있습니다. "DNS 해석 단계인지, kube-proxy DNAT 단계인지, Transit Gateway 라우팅 단계인지"를 구분할 수 있느냐가 트러블슈팅 속도를 결정합니다.

## References

- [Kubernetes Cluster Networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/)
- [The Kubernetes Network Model](https://kubernetes.io/docs/concepts/services-networking/)
- [CNI (Container Network Interface)](https://github.com/containernetworking/cni)
- [kube-proxy](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [Istio Multi-cluster Installation](https://istio.io/latest/docs/setup/install/multicluster/)
- [AWS Transit Gateway](https://docs.aws.amazon.com/vpc/latest/tgw/what-is-transit-gateway.html)
