---
layout: single
title: "Kubernetes 네트워크 심화: BGP 라우팅과 iptables/IPVS 로드밸런싱"
date: 2026-02-07 18:46:00 +0900
categories: kubernetes
tags: [kubernetes, networking, bgp, calico, iptables, ipvs, kube-proxy, netfilter, metallb]
excerpt: "Kubernetes Service에 패킷이 도달하면 내부에서 어떤 일이 벌어질까? Netfilter 체인을 타는 iptables의 확률 기반 분배부터 IPVS의 해시 테이블 로드밸런싱, 그리고 Calico BGP로 Pod CIDR을 물리 네트워크에 광고하는 원리까지 깊이 있게 살펴봅니다."
---

## 들어가며

[이전 글](/kubernetes/kubernetes-packet-flow-multicluster)에서 Kubernetes 패킷 흐름을 Pod 내부부터 멀티 클러스터까지 전체적으로 살펴보았습니다. 그 과정에서 "kube-proxy가 iptables/IPVS 규칙으로 DNAT를 수행한다", "Calico가 BGP로 Pod CIDR을 광고한다"는 내용을 다뤘는데, 각각의 내부 동작까지는 깊이 들어가지 못했습니다.

이 글에서는 그 두 가지를 깊이 있게 다룹니다. 먼저 kube-proxy의 두 가지 모드인 iptables와 IPVS가 각각 어떻게 Service 로드밸런싱을 구현하는지 Netfilter 체인 레벨에서 살펴보고, 이어서 BGP가 Kubernetes 네트워크에서 어떤 역할을 하는지 Calico와 MetalLB를 예시로 알아보겠습니다.

## iptables 모드 — Netfilter 기반 Service 로드밸런싱

### Netfilter 체인 구조

iptables는 Linux 커널의 **Netfilter 프레임워크** 를 제어하는 도구입니다. Netfilter는 커널의 네트워크 스택에서 패킷이 지나가는 경로에 **훅 포인트(체인)** 을 제공하고, 각 체인에 규칙을 등록하여 패킷을 필터링하거나 변환할 수 있습니다.

```
패킷 수신
    │
    ▼
┌──────────┐     ┌──────────┐     ┌──────────┐
│PREROUTING│────▶│ ROUTING  │────▶│ FORWARD  │───▶ 다른 Pod/노드로 전달
│          │     │ DECISION │     │          │
└──────────┘     └────┬─────┘     └──────────┘
                      │
                      │ (로컬 프로세스 대상)
                      ▼
                ┌──────────┐     ┌───────────┐
                │  INPUT   │────▶│  LOCAL    │
                │          │     │  PROCESS  │
                └──────────┘     └─────┬─────┘
                                       │
                                       ▼
                                 ┌──────────┐     ┌────────────┐
                                 │  OUTPUT  │────▶│POSTROUTING │───▶ 외부
                                 └──────────┘     └────────────┘
```

kube-proxy는 이 체인 구조에 **KUBE-SERVICES**, **KUBE-SVC-***, **KUBE-SEP-*** 같은 커스텀 체인을 추가하여 Service 로드밸런싱을 구현합니다. 패킷이 PREROUTING 체인을 지날 때 Service의 ClusterIP를 매칭하고, DNAT으로 실제 Pod IP로 변환하는 것입니다.

### kube-proxy가 생성하는 iptables 규칙

Service `my-svc` (ClusterIP: 10.96.0.100:80)에 3개의 Endpoint가 있을 때 생성되는 규칙을 보겠습니다.

```bash
# KUBE-SERVICES 체인: Service IP 매칭
-A KUBE-SERVICES -d 10.96.0.100/32 -p tcp --dport 80 \
    -j KUBE-SVC-XXXX

# KUBE-SVC-XXXX 체인: Endpoint 선택 (확률 기반 로드밸런싱)
-A KUBE-SVC-XXXX -m statistic --mode random --probability 0.3333 \
    -j KUBE-SEP-AAA
-A KUBE-SVC-XXXX -m statistic --mode random --probability 0.5000 \
    -j KUBE-SEP-BBB
-A KUBE-SVC-XXXX \
    -j KUBE-SEP-CCC

# KUBE-SEP-AAA: 실제 DNAT (Endpoint 1)
-A KUBE-SEP-AAA -p tcp \
    -j DNAT --to-destination 10.244.1.10:8080

# KUBE-SEP-BBB: 실제 DNAT (Endpoint 2)
-A KUBE-SEP-BBB -p tcp \
    -j DNAT --to-destination 10.244.2.20:8080

# KUBE-SEP-CCC: 실제 DNAT (Endpoint 3)
-A KUBE-SEP-CCC -p tcp \
    -j DNAT --to-destination 10.244.3.30:8080
```

### 확률 기반 로드밸런싱의 작동 원리

iptables의 `--probability` 옵션을 사용한 분배 방식이 직관적이지 않을 수 있습니다. 3개 Endpoint로 균등 분배하는 원리를 보겠습니다.

```
패킷이 KUBE-SVC-XXXX 체인에 진입:

첫 번째 규칙: probability 1/3 (0.3333)
  → 33.3% 확률로 Endpoint 1 선택 → KUBE-SEP-AAA로 점프

  (선택되지 않은 66.7%가 다음 규칙으로)

두 번째 규칙: probability 1/2 (0.5000)
  → 나머지 66.7% 중 50% = 33.3% 확률로 Endpoint 2 선택

  (선택되지 않은 33.3%가 다음 규칙으로)

세 번째 규칙: (확률 없음, 나머지 전부)
  → 33.3% 확률로 Endpoint 3 선택

결과: 각 Endpoint에 약 1/3씩 균등 분배
```

N개의 Endpoint가 있을 때 k번째 규칙의 확률은 `1/(N-k+1)`입니다. 이 방식은 수학적으로 균등 분배를 보장하지만, **실제 로드밸런싱 알고리즘이 아니라 확률적 근사**라는 한계가 있습니다. 현재 연결 수나 응답 시간을 고려하지 않습니다.

### iptables의 성능 문제

iptables 규칙은 **순차적으로 매칭**(O(n))됩니다. Service와 Endpoint 수가 늘어나면 규칙 수도 비례하여 증가합니다.

```
Service 수에 따른 규칙 수 증가:

Service 10개 × Endpoint 3개  = ~90 규칙
Service 100개 × Endpoint 3개 = ~900 규칙
Service 1,000개 × Endpoint 10개 = ~30,000 규칙
Service 10,000개 × Endpoint 10개 = ~300,000 규칙
```

규칙 매칭은 위에서부터 순차 탐색이므로, 30만 개의 규칙이 있으면 최악의 경우 30만 번 비교해야 합니다. 또한 규칙 업데이트 시 전체 규칙을 atomic replace하므로, 대규모 클러스터에서는 업데이트 자체에도 시간이 걸립니다.

### iptables 디버깅

```bash
# Service 관련 NAT 규칙 확인
$ iptables -t nat -L KUBE-SERVICES -n | grep 10.96.0.100
KUBE-SVC-XXXX  tcp  --  0.0.0.0/0  10.96.0.100  tcp dpt:80

# 특정 Service의 Endpoint 규칙 확인
$ iptables -t nat -L KUBE-SVC-XXXX -n
KUBE-SEP-AAA  all  --  0.0.0.0/0  0.0.0.0/0  statistic mode random probability 0.33333
KUBE-SEP-BBB  all  --  0.0.0.0/0  0.0.0.0/0  statistic mode random probability 0.50000
KUBE-SEP-CCC  all  --  0.0.0.0/0  0.0.0.0/0

# DNAT 대상 확인
$ iptables -t nat -L KUBE-SEP-AAA -n
DNAT  tcp  --  0.0.0.0/0  0.0.0.0/0  tcp to:10.244.1.10:8080

# 전체 규칙 수 확인
$ iptables -t nat -L | wc -l
```

## IPVS 모드 — 커널 레벨 L4 로드밸런서

### IPVS란?

IPVS(IP Virtual Server)는 Linux 커널에 내장된 **L4 로드밸런서** 입니다. LVS(Linux Virtual Server) 프로젝트의 일부로, 원래 고성능 로드밸런싱을 위해 설계되었습니다. iptables가 범용 패킷 필터링 도구인 반면, IPVS는 로드밸런싱에 특화되어 있습니다.

### IPVS 아키텍처

```
패킷 수신
    │
    ▼
PREROUTING (Netfilter)
    │
    ▼
┌────────────────────────────────────────────┐
│  IPVS (커널 모듈: ip_vs)                    │
│                                            │
│  Virtual Server Table (해시 테이블):       │
│  ┌──────────────────┬────────────────┐     │
│  │ VIP:Port         │ Real Servers   │     │
│  ├──────────────────┼────────────────┤     │
│  │ 10.96.0.100:80   │ 10.244.1.10   │     │
│  │                  │ 10.244.2.20   │     │  ← O(1) 해시 조회
│  │                  │ 10.244.3.30   │     │
│  ├──────────────────┼────────────────┤     │
│  │ 10.96.0.200:443  │ 10.244.1.50   │     │
│  │                  │ 10.244.3.60   │     │
│  └──────────────────┴────────────────┘     │
│                                            │
│  LB 알고리즘으로 Real Server 선택          │
│  → DNAT 적용                               │
└────────────────────────────────────────────┘
    │
    ▼
FORWARD / LOCAL (일반 라우팅)
```

iptables와의 가장 큰 차이는 **해시 테이블 기반 조회(O(1))** 입니다. Service가 1만 개든 10만 개든 조회 시간이 일정합니다.

### IPVS 로드밸런싱 알고리즘

IPVS는 iptables의 확률 기반 분배와 달리, 실제 로드밸런싱 알고리즘을 제공합니다.

| 알고리즘 | 약자 | 동작 방식 | 적합한 상황 |
|---------|------|----------|-----------|
| Round Robin | rr | 순차적 분배 | 기본값, 균일한 요청 |
| Least Connection | lc | 활성 연결 수 적은 서버 선택 | 요청 처리 시간이 불균일할 때 |
| Destination Hashing | dh | 목적지 IP 해시 | 캐시 서버 |
| Source Hashing | sh | 소스 IP 해시 | 세션 어피니티 |
| Weighted Round Robin | wrr | 가중치 기반 순차 분배 | 서버 성능이 다를 때 |
| Shortest Expected Delay | sed | 예상 지연 최소 서버 선택 | 지연 시간 최적화 |

```bash
# kube-proxy IPVS 스케줄러 설정
--proxy-mode=ipvs
--ipvs-scheduler=rr  # 기본값
```

`lc`(Least Connection)를 사용하면 현재 활성 연결이 적은 Pod에 더 많은 트래픽을 보내 실질적인 부하 균등 분산이 가능합니다. iptables의 확률 기반 분배로는 불가능한 기능입니다.

### IPVS 상태 확인

```bash
$ ipvsadm -Ln

IP Virtual Server version 1.2.1
Prot LocalAddress:Port Scheduler Flags
  -> RemoteAddress:Port           Forward Weight ActiveConn InActConn

TCP  10.96.0.100:80 rr
  -> 10.244.1.10:8080             Masq    1      3          12
  -> 10.244.2.20:8080             Masq    1      2          8
  -> 10.244.3.30:8080             Masq    1      4          15

TCP  10.96.0.200:443 rr
  -> 10.244.1.50:8443             Masq    1      1          5
  -> 10.244.3.60:8443             Masq    1      2          7
```

iptables와 달리 **현재 Active Connection 수와 Inactive Connection 수** 를 바로 확인할 수 있어 트러블슈팅이 훨씬 용이합니다. 특정 Pod에 연결이 편중되는지, Pod가 Endpoint에서 제거된 후에도 남아있는 연결이 있는지 등을 즉시 파악할 수 있습니다.

### IPVS와 iptables의 협업

IPVS 모드에서도 iptables가 완전히 사라지는 것은 아닙니다.

```
IPVS가 담당하는 것:
  - Service ClusterIP → Endpoint Pod IP DNAT (로드밸런싱 핵심)
  - 로드밸런싱 알고리즘 적용
  - 연결 추적

iptables가 여전히 담당하는 것:
  - SNAT (masquerade): 노드 외부로 나갈 때 소스 IP 변환
  - NodePort: 노드 포트 매핑 일부
  - externalTrafficPolicy 처리
  - 패킷 마킹 (IPVS로 보내기 위한 전처리)
```

kube-proxy가 IPVS 모드로 동작할 때 `iptables -t nat -L`을 확인하면 여전히 규칙이 있지만, Service별 체인(KUBE-SVC-*, KUBE-SEP-*)이 없어지고 대신 IPVS가 그 역할을 합니다.

### dummy 인터페이스와 ClusterIP

IPVS 모드에서 한 가지 주목할 점은 **kube-ipvs0** 이라는 dummy 네트워크 인터페이스입니다.

```bash
$ ip addr show kube-ipvs0
kube-ipvs0: <BROADCAST,NOARP> mtu 1500
    inet 10.96.0.1/32 scope global kube-ipvs0       # kubernetes Service
    inet 10.96.0.10/32 scope global kube-ipvs0      # kube-dns Service
    inet 10.96.0.100/32 scope global kube-ipvs0     # my-svc Service
    inet 10.96.0.200/32 scope global kube-ipvs0     # another-svc Service
```

IPVS는 Virtual Server의 VIP가 로컬 인터페이스에 바인딩되어 있어야 패킷을 가로챌 수 있습니다. kube-proxy는 모든 Service의 ClusterIP를 이 dummy 인터페이스에 바인딩하여 IPVS가 처리할 수 있게 합니다. iptables 모드에서는 이 인터페이스가 필요 없는데, Netfilter가 ClusterIP를 인터페이스 바인딩 없이도 매칭할 수 있기 때문입니다.

## iptables vs IPVS 최종 비교

| 항목 | iptables | IPVS |
|-----|---------|------|
| Service 조회 | O(n) 체인 순차 탐색 | O(1) 해시 테이블 |
| 로드밸런싱 | 확률 기반 (random) | rr, lc, wrr, sh, sed 등 |
| 규칙 업데이트 | 전체 교체 (atomic replace) | 증분 업데이트 (개별 추가/삭제) |
| 세션 어피니티 | iptables recent 모듈 | IPVS 내장 (persistent connection) |
| 연결 상태 확인 | 불가 | `ipvsadm -Ln`으로 즉시 확인 |
| Service 1,000개 | 눈에 띄는 지연 | 영향 미미 |
| Service 10,000개 | 심각한 성능 저하 | 영향 미미 |
| 커널 요구사항 | 기본 내장 | `ip_vs` 커널 모듈 필요 |
| 디버깅 | `iptables -t nat -L` | `ipvsadm -Ln` |

대규모 클러스터(Service 수백 개 이상)에서는 IPVS 모드가 권장됩니다. 규모가 작은 환경에서는 iptables도 충분하지만, IPVS의 디버깅 편의성과 다양한 로드밸런싱 알고리즘이 이점이 됩니다.

## BGP (Border Gateway Protocol) — Pod CIDR의 물리 네트워크 광고

### BGP란?

BGP는 **인터넷의 라우팅 프로토콜** 입니다. 인터넷을 구성하는 수만 개의 AS(Autonomous System, 자율 시스템) 간에 "어떤 IP 대역이 어디에 있는지"를 알려주는 역할을 합니다.

Kubernetes에서는 Calico, MetalLB 등이 BGP를 사용하여 **Pod CIDR이나 Service IP를 물리 네트워크에 광고**합니다. [이전 글](/kubernetes/kubernetes-packet-flow-multicluster)에서 CNI의 Native Routing 방식으로 소개했던 것이 바로 이 BGP 기반 라우팅입니다.

```
인터넷 수준:
┌─────────────┐          ┌─────────────┐
│   AS 64500  │   BGP    │   AS 64501  │
│   (ISP A)   │◄────────►│   (ISP B)   │
│             │ "나는     │             │
│ 203.0.113   │  203.0.113│             │
│ .0/24를     │  .0/24를  │             │
│ 가지고 있다"│  광고     │             │
└─────────────┘          └─────────────┘

Kubernetes 수준:
┌─────────────┐          ┌─────────────┐
│   Node 1    │   BGP    │  ToR Switch │
│   (Calico)  │◄────────►│  (네트워크) │
│             │ "나는     │             │
│ 10.244.1    │ 10.244.1  │ 라우팅      │
│ .0/24 Pod를 │ .0/24를   │ 테이블에    │
│ 가지고 있다"│  광고     │ 추가        │
└─────────────┘          └─────────────┘
```

원리는 동일합니다. 인터넷에서 ISP가 자신의 IP 대역을 BGP로 광고하는 것과 마찬가지로, Kubernetes 노드가 자신의 Pod CIDR을 BGP로 광고합니다.

### BGP 핵심 용어

| 용어 | 의미 | Kubernetes 맥락 |
|-----|------|----------------|
| **AS (Autonomous System)** | 하나의 관리 도메인 | 클러스터 또는 DC |
| **AS Number (ASN)** | AS의 고유 번호 (16bit 또는 32bit) | Calico 설정에서 지정 |
| **Prefix** | 광고하는 IP 대역 | Pod CIDR (10.244.1.0/24) |
| **Peer** | BGP 세션을 맺는 상대 | ToR 스위치, 다른 노드 |
| **iBGP** | 같은 AS 내부의 BGP | 노드 간 (full-mesh) |
| **eBGP** | 다른 AS 간의 BGP | 클러스터 ↔ DC 네트워크 |
| **BIRD** | BGP 라우팅 데몬 | Calico가 사용하는 BGP 구현체 |

### Calico BGP 모드 동작

Calico는 각 노드에서 **BIRD** BGP 데몬을 실행합니다.

```
┌────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster (AS 64512)                             │
│                                                            │
│  ┌─────────────┐    iBGP      ┌─────────────┐            │
│  │   Node 1    │◄────────────►│   Node 2    │            │
│  │             │              │             │            │
│  │ Pod CIDR:   │              │ Pod CIDR:   │            │
│  │ 10.244.1/24 │              │ 10.244.2/24 │            │
│  │             │              │             │            │
│  │ BIRD daemon │              │ BIRD daemon │            │
│  │ (BGP 스피커)│              │ (BGP 스피커)│            │
│  └──────┬──────┘              └──────┬──────┘            │
│         │ eBGP                        │ eBGP              │
└─────────┼────────────────────────────┼────────────────────┘
          │                            │
          ▼                            ▼
┌──────────────────────────────────────────────────────────┐
│  ToR Switch (Top of Rack) / DC Router (AS 64500)          │
│                                                           │
│  BGP로 수신한 라우팅 정보:                                 │
│  10.244.1.0/24 → next-hop: Node 1 (192.168.1.10)        │
│  10.244.2.0/24 → next-hop: Node 2 (192.168.1.11)        │
│                                                           │
│  → 이 정보가 DC 네트워크 전체로 전파                       │
│  → 다른 랙, 다른 클러스터에서도 Pod에 직접 도달 가능       │
└──────────────────────────────────────────────────────────┘
```

BIRD가 해당 노드의 Pod CIDR을 BGP로 광고하면, ToR 스위치가 이 정보를 라우팅 테이블에 추가합니다. 이후 다른 노드나 외부에서 해당 Pod CIDR로 패킷을 보내면 표준 IP 라우팅으로 올바른 노드에 도달합니다. VXLAN 같은 캡슐화가 필요 없으므로 오버헤드가 없습니다.

### iBGP Full-mesh와 Route Reflector

노드 간 iBGP에는 두 가지 방식이 있습니다.

**Full-mesh (기본값)**: 모든 노드가 서로 직접 BGP 세션을 맺습니다.

```
       Node 1
      / | \
     /  |  \
Node 2  |  Node 4
     \  |  /
      \ | /
       Node 3

노드 N개 → 세션 수: N×(N-1)/2
노드 100개 → 4,950개 세션 → 관리 부담 증가
```

**Route Reflector**: 대규모 클러스터에서는 일부 노드를 Route Reflector로 지정하여 세션 수를 줄입니다.

```
         ┌────────────────┐
         │ Route Reflector │
         │ (Node 1)       │
         └───┬───┬───┬────┘
             │   │   │
       ┌─────┘   │   └─────┐
       ▼         ▼         ▼
    Node 2    Node 3    Node 4
    Node 5    Node 6    ...

각 노드는 RR에만 세션 → 세션 수: N개
RR이 경로 정보를 모든 클라이언트에 반사(reflect)
```

```yaml
# Calico BGPConfiguration
apiVersion: crd.projectcalico.org/v1
kind: BGPConfiguration
metadata:
  name: default
spec:
  asNumber: 64512
  nodeToNodeMeshEnabled: false  # full-mesh 비활성화 (RR 사용 시)
```

```yaml
# Route Reflector로 동작할 노드 지정
apiVersion: crd.projectcalico.org/v1
kind: BGPPeer
metadata:
  name: route-reflector
spec:
  peerIP: 192.168.1.10          # RR 노드 IP
  asNumber: 64512
  nodeSelector: "!route-reflector"  # RR이 아닌 모든 노드에서 피어링
```

### BGP 피어링 설정 — ToR 스위치 연결

클러스터 외부 네트워크와의 연결을 위해 ToR 스위치와 eBGP 피어링을 설정합니다.

```yaml
# ToR 스위치와의 BGP 피어링
apiVersion: crd.projectcalico.org/v1
kind: BGPPeer
metadata:
  name: tor-switch
spec:
  peerIP: 192.168.1.1           # ToR 스위치 IP
  asNumber: 64500               # 스위치의 AS 번호
  nodeSelector: all()           # 모든 노드에서 피어링
```

이 설정으로 각 노드의 BIRD가 ToR 스위치(192.168.1.1)와 BGP 세션을 맺고, 자신의 Pod CIDR을 광고합니다. ToR 스위치는 이 정보를 DC 라우팅 인프라에 전파하여, DC 내 어디서든 Pod에 직접 접근할 수 있게 됩니다.

### MetalLB BGP 모드

온프레미스 환경에서 LoadBalancer 타입 Service의 External IP를 BGP로 광고하는 용도로도 BGP가 사용됩니다. MetalLB가 대표적입니다.

```
┌──────────────────────────────────────┐
│  Kubernetes Cluster                  │
│                                      │
│  Service (type: LoadBalancer)        │
│  External IP: 10.10.10.100          │
│                                      │
│  MetalLB Speaker (BGP 모드)          │
│  → 10.10.10.100/32를 BGP로 광고     │
└──────────────┬───────────────────────┘
               │ BGP
               ▼
┌──────────────────────────────────────┐
│  네트워크 라우터                      │
│                                      │
│  라우팅 테이블:                       │
│  10.10.10.100/32 → Node X (next-hop)│
│                                      │
│  외부에서 10.10.10.100으로 접근 시   │
│  Node X로 라우팅                     │
└──────────────────────────────────────┘
```

클라우드 환경에서는 클라우드 제공자가 LoadBalancer를 자동으로 프로비저닝하지만, 온프레미스에서는 그런 인프라가 없습니다. MetalLB가 BGP를 사용하여 Service의 External IP를 네트워크 라우터에 광고함으로써, 온프레미스에서도 LoadBalancer 타입 Service를 사용할 수 있게 합니다.

```yaml
# MetalLB BGP 설정
apiVersion: metallb.io/v1beta2
kind: BGPPeer
metadata:
  name: router
  namespace: metallb-system
spec:
  myASN: 64512
  peerASN: 64500
  peerAddress: 192.168.1.1

---
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: external-pool
  namespace: metallb-system
spec:
  addresses:
  - 10.10.10.0/24               # 할당할 External IP 풀

---
apiVersion: metallb.io/v1beta1
kind: BGPAdvertisement
metadata:
  name: external
  namespace: metallb-system
spec:
  ipAddressPools:
  - external-pool
```

## 정리

Kubernetes의 Service 로드밸런싱과 Pod 네트워크 라우팅을 구현하는 핵심 기술을 정리하면 다음과 같습니다.

| 기술 | 역할 | 핵심 메커니즘 | 적합한 환경 |
|-----|------|------------|-----------|
| iptables | Service → Pod DNAT | Netfilter 체인 + 확률 분배 | 소규모 클러스터 |
| IPVS | Service → Pod DNAT | 해시 테이블 + LB 알고리즘 | 대규모 클러스터 |
| Calico BGP | Pod CIDR 라우팅 광고 | BGP로 물리 네트워크에 경로 전파 | 온프레미스, 고성능 |
| MetalLB BGP | External IP 라우팅 광고 | BGP로 LB IP를 네트워크에 전파 | 온프레미스 LB |

이 기술들이 어느 시점에 동작하는지를 이전 글의 패킷 흐름에 대입해보면, Service에 대한 요청이 들어왔을 때 **kube-proxy(iptables/IPVS)가 DNAT으로 Pod IP를 결정**하고, 그 Pod가 다른 노드에 있다면 **CNI(Calico BGP)가 설정한 라우팅 테이블** 을 따라 패킷이 올바른 노드에 전달됩니다. 두 기술이 각자의 레이어에서 협력하여 "Service 이름으로 요청하면 어떤 노드의 어떤 Pod든 도달한다"는 Kubernetes의 네트워크 추상화를 완성하는 것입니다.
