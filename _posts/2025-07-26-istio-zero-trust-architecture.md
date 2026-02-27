---
layout: single
title: "Istio를 활용한 제로 트러스트 아키텍처"
date: 2025-07-26 04:42:00 +0000
last_modified_at: 2026-02-17
categories: [kubernetes]
tags: [istio, service-mesh, zero-trust, security, kubernetes, mtls]
excerpt: "Istio 서비스 메시를 활용한 제로 트러스트 아키텍처 구현과 mTLS를 통한 클러스터 내부 보안 강화 방안을 다룹니다."
---

> Zero Trust - Never Trust, Always Verify

이 글은 [Istio를 활용한 Zero Trust 구현](https://www.youtube.com/watch?v=4sJd6PIkP_s) 영상 및 자료의 내용을 바탕으로 재구성되었습니다.

<!--more-->

## Nginx Ingress Controller와 Istio의 차이

회사에서 쿠버네티스 클러스터를 구성할 때, 클러스터 앞단에 구성되는 LB의 구성을 고민하다가 Nginx Ingress Controller를 앞단에 두기로 했습니다. 그 앞단에 있는 HA Proxy가 L4 로드 밸런서의 기능을 하는 반면, Nginx Ingress Controller는 **L7 로드 밸런서로서 Ingress로 정의된 다양한 백엔드로 요청을 라우팅**하는 **어플리케이션 레벨에서의 로드밸런싱**이 가능합니다. 또한 **경로 기반 라우팅**이 가능합니다.

Nginx Ingress Controller는 외부에서 내부로 들어오는 트래픽을 처리하고 **SSL/TLS Termination**을 처리하는 등 보안 역할도 담당합니다.

```
HTTPS → [Nginx IC - SSL 종료] → HTTP(평문) → 클러스터 내부
```

이렇게 Nginx Ingress Controller를 구성한 후, Istio의 구성도 검토하게 되었습니다. 여기서 "둘의 차이가 뭐냐"는 질문을 받았는데, Istio의 역할에 대해 구체적으로 **왜** 사용하는지 명확한 이유를 정리해 보았습니다.

---

## Istio란?

Nginx Ingress Controller와 달리 Istio는 어떤 역할을 할까요?

**역할**
- Istio는 클러스터 내부의 서비스 간 통신을 관리하는 **서비스 메시** 입니다.
- 서비스 간의 모든 트래픽을 제어, 보안, 관찰하는 것이 주요 목적입니다.

**주요 기능**

| 기능 | 설명 |
|------|------|
| 트래픽 관리 | 라우팅 규칙, 로드밸런싱, 서킷브레이커, 타임아웃, 재시도 |
| 보안 | mTLS 암호화, 서비스 간 인증/인가, 정책 적용 |
| 관찰성 | 분산 트레이싱, 메트릭 수집, 접근 로깅 |
| 정책 적용 | 속도 제한, 접근 제어, 할당량 관리 |

**작동 방식**

```
┌─────────────────────────────────────────────────────────────────┐
│                    Istio 아키텍처                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Control Plane (istiod)                                        │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Pilot (설정)  │  Citadel (인증서)  │  Galley (검증)     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                           │                                     │
│                           ▼ 설정/인증서 배포                     │
│   Data Plane                                                    │
│   ┌─────────────────┐    ┌─────────────────┐                   │
│   │ Pod A           │    │ Pod B           │                   │
│   │ ┌─────────────┐ │    │ ┌─────────────┐ │                   │
│   │ │  App        │ │    │ │  App        │ │                   │
│   │ └──────┬──────┘ │    │ └──────┬──────┘ │                   │
│   │ ┌──────┴──────┐ │    │ ┌──────┴──────┐ │                   │
│   │ │ Envoy Proxy │◄├────┼─┤ Envoy Proxy │ │                   │
│   │ └─────────────┘ │    │ └─────────────┘ │                   │
│   └─────────────────┘    └─────────────────┘                   │
│                           mTLS 암호화 통신                       │
└─────────────────────────────────────────────────────────────────┘
```

각 Pod에는 애플리케이션 컨테이너와 함께 **Envoy 사이드카 프록시**가 자동 주입됩니다. 모든 인바운드/아웃바운드 트래픽은 이 Envoy를 통과하며, 이를 통해 트래픽 제어와 보안이 적용됩니다.

> **Nginx Ingress Controller** 는 외부에서 내부로 들어오는 클러스터의 "**출입문**" 역할을 하고, **Istio** 는 "**내부 교통 관리 시스템**"에 해당합니다.

---

## SSL Termination과 mTLS를 같이 쓰자

처음에는 "SSL Termination을 이미 하는데, mTLS를 굳이 같이 써야 하나?"라고 생각했습니다. 하지만 둘은 같이 사용할 때 더 강력한 보안을 제공하고, 내부에서 mTLS를 사용해야만 완벽한 제로 트러스트를 갖출 수 있습니다.

### SSL/TLS Termination

Nginx Ingress Controller 기준으로 SSL/TLS Termination이 이뤄지는 절차는 다음과 같습니다.

1. 클라이언트가 HTTPS로 요청을 보내면, Nginx Ingress Controller가 이 요청을 받아 TLS 암호화를 해제합니다.
2. 복호화된 일반 HTTP 트래픽을 내부의 백엔드 서비스로 전달합니다.
3. 이때 Nginx Ingress Controller와 백엔드 서비스 사이의 통신은 기본적으로 **평문(plaintext)** 입니다.

### mTLS(Mutual TLS)

Istio의 mTLS는 클러스터 내부의 서비스 간 통신을 담당합니다.

1. Nginx Ingress Controller가 요청을 백엔드로 보내려고 할 때, Istio가 주입한 Envoy가 그 트래픽을 가로챕니다.
2. Istio의 mTLS가 STRICT 모드로 설정되어 있으면, Envoy 프록시 간의 통신은 자동으로 **상호 인증(Mutual Authentication)과 암호화**가 적용됩니다.
3. 즉, Nginx Ingress Controller가 보낸 평문 트래픽을 백엔드의 Envoy가 받아서 다시 암호화하고 검증합니다.

```
┌──────────────────────────────────────────────────────────────────┐
│             SSL Termination + mTLS 통합 아키텍처                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [Client] ──HTTPS──► [Nginx IC] ──HTTP──► [Envoy] ──mTLS──► [Envoy] ──► [App] │
│                        │                    │                 │         │
│                  SSL Termination      재암호화          복호화    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## mTLS가 필요한 이유

처음에는 "왜 외부에서 이미 암호화된 통신을 굳이 내부에서 또 암호화해야 하나?"라고 생각했습니다. 하지만 몇 가지 케이스를 통해 내부에서도 mTLS 통신이 필요한 이유를 알 수 있습니다.

### 1. 내부 공격 위험

클러스터 내부의 한 서비스가 악성 코드를 포함하거나, 공격자가 이미 내부 네트워크에 침투했을 가능성이 있습니다. 내부 통신이 평문이라면 공격자는 쉽게 데이터를 탈취할 수 있습니다.

### 2. 경계의 취약성

SSL Termination이 이뤄지는 Nginx Ingress Controller는 외부 공격의 주요 표적입니다. 만약 이 Nginx Ingress Controller가 해킹당한다면, 내부의 평문 통신에서 모든 민감 정보가 노출될 수 있습니다.

### 3. 서비스 간 인증

HTTPS는 클라이언트가 서버의 신원을 확인하는 **단방향 인증** 입니다. 하지만 MSA 환경에서는 서비스 A가 B를 호출할 때, **B도 서비스 A가 정당한 서비스인지 확인**해야 합니다. mTLS는 상호 인증(mutual authentication)을 통해 정해진 권한대로만 통신할 수 있게 합니다.

이를 통해 **"매번 검증하라"**라는 제로 트러스트 아키텍처를 구현할 수 있습니다.

---

## Zero Trust Architecture

Istio의 mTLS는 제로 트러스트 아키텍처의 구성 요소 중 하나이지만, 제로 트러스트의 일부분에 불과합니다.

제로 트러스트 아키텍처는 NIST(미국 국립표준기술원), Gartner 등 공신력 있는 기관들과 클라우드 벤더(Google, Microsoft)가 제시하는 보안의 핵심 원칙입니다.
- [NIST Zero Trust Architecture](https://www.nist.gov/publications/zero-trust-architecture)

아래는 제로 트러스트 아키텍처를 구현하기 위한 필수 요소들입니다.

### 1. 신원 및 접근 관리 (IAM)

요청에 대해 "누구"인지 확인하는 절차는 매우 중요하고 기본이 되는 요소입니다.

| 요소 | 설명 |
|------|------|
| 다중 인증 (MFA) | 사용자 이름/비밀번호 외에 추가적인 인증 수단 요구 (OTP, 생체 인식 등) |
| 최소 권한의 원칙 (PoLP) | 사용자나 시스템에 필요한 최소 권한만 부여 |
| 중앙 집중식 접근 제어 | 역할, 디바이스 상태, 접근 시간, 위치 등을 고려한 동적 접근 제어 |

### 2. Microsegmentation

네트워크를 작은 단위로 세분화하여 워크로드 간의 통신을 제어하는 기술입니다. **Istio의 mTLS**가 바로 이 마이크로세그멘테이션의 핵심 기술입니다.

| 요소 | 설명 |
|------|------|
| 횡적 이동 방지 | 한 워크로드가 침해당해도 다른 워크로드로 이동하는 것을 방지 |
| 워크로드 단위 정책 | 예: 웹 서버는 백엔드와 통신하지만, DB와는 직접 통신 불가 |

### 3. 지속적인 모니터링 및 분석

제로 트러스트는 "한 번 검증하면 끝"이 아닙니다. 모든 활동을 지속적으로 감시하고 분석해야 합니다.

| 요소 | 설명 |
|------|------|
| 실시간 위협 탐지 | 모든 네트워크 트래픽, 사용자 활동을 실시간 모니터링 |
| 행동 분석 | 평소와 다른 행동(비정상적인 시간 접속, 사용하지 않던 리소스 접근) 감지 |
| 로깅 및 감사 | 모든 접근 및 활동 기록 보존 |

### 4. 디바이스 보안 및 관리

사용자뿐만 아니라 사용자가 사용하는 디바이스도 검증 대상입니다.

| 요소 | 설명 |
|------|------|
| 디바이스 상태 확인 | 최신 보안 패치 적용 여부, 안티바이러스 활성화 여부 확인 |
| 모바일 디바이스 관리 (MDM) | 분실 시 원격 데이터 삭제 등 |

### 5. 데이터 보호

데이터는 제로 트러스트 아키텍처의 최종 보호 대상입니다.

| 요소 | 설명 |
|------|------|
| 데이터 분류 및 암호화 | 중요도에 따라 분류하고, 민감 데이터는 암호화 저장/전송 |
| 데이터 손실 방지 (DLP) | 민감 데이터의 외부 유출 모니터링 및 제어 |

---

## Istio를 활용한 mTLS 구현

### PeerAuthentication 설정

mTLS를 활성화하려면 `PeerAuthentication` 리소스를 생성합니다.

```yaml
# 네임스페이스 전체에 STRICT mTLS 적용
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT
```

| 모드 | 설명 |
|------|------|
| STRICT | mTLS만 허용 (평문 트래픽 거부) |
| PERMISSIVE | mTLS와 평문 모두 허용 (마이그레이션용) |
| DISABLE | mTLS 비활성화 |

### AuthorizationPolicy 설정

서비스 간 접근을 제어하려면 `AuthorizationPolicy`를 사용합니다.

```yaml
# frontend 서비스만 backend 서비스에 접근 허용
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: backend-policy
  namespace: production
spec:
  selector:
    matchLabels:
      app: backend
  action: ALLOW
  rules:
    - from:
        - source:
            principals: ["cluster.local/ns/production/sa/frontend"]
      to:
        - operation:
            methods: ["GET", "POST"]
            paths: ["/api/*"]
```

### Gateway와 VirtualService 설정

외부 트래픽을 Istio를 통해 라우팅하려면 Gateway와 VirtualService를 설정합니다.

```yaml
# Gateway: 외부 트래픽 진입점
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: app-gateway
spec:
  selector:
    istio: ingressgateway
  servers:
    - port:
        number: 443
        name: https
        protocol: HTTPS
      tls:
        mode: SIMPLE
        credentialName: app-tls-secret
      hosts:
        - "app.example.com"
---
# VirtualService: 트래픽 라우팅 규칙
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: app-routing
spec:
  hosts:
    - "app.example.com"
  gateways:
    - app-gateway
  http:
    - match:
        - uri:
            prefix: /api
      route:
        - destination:
            host: backend
            port:
              number: 8080
    - route:
        - destination:
            host: frontend
            port:
              number: 80
```

### mTLS 적용 확인

```bash
# mTLS 상태 확인
istioctl x authz check <pod-name>

# 트래픽 암호화 여부 확인
kubectl exec -it <pod-name> -c istio-proxy -- \
  curl -v http://backend:8080/api/health 2>&1 | grep "TLS"

# PeerAuthentication 상태 확인
kubectl get peerauthentication -A
```

---

## 정리

| 구성 요소 | 역할 | Istio 리소스 |
|----------|------|-------------|
| 외부 진입 | TLS Termination, L7 라우팅 | Gateway |
| 내부 통신 암호화 | mTLS 자동 적용 | PeerAuthentication |
| 서비스 간 인가 | 접근 정책 적용 | AuthorizationPolicy |
| 트래픽 라우팅 | 경로 기반 라우팅, 트래픽 분할 | VirtualService |

Istio를 활용하면 애플리케이션 코드 수정 없이 클러스터 내부에 제로 트러스트 보안 모델을 적용할 수 있습니다. 이를 통해 **"신뢰하지 말고, 항상 검증하라"**는 원칙을 인프라 레벨에서 구현할 수 있습니다.

---

## 참고

- [Istio 공식 문서](https://istio.io/latest/docs/)
- [NIST Zero Trust Architecture](https://www.nist.gov/publications/zero-trust-architecture)
- [Istio Security Best Practices](https://istio.io/latest/docs/ops/best-practices/security/)
