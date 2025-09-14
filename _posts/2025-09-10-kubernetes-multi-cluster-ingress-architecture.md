---
layout: single
title: "Kubernetes 멀티 클러스터 Ingress 아키텍처 설계"
date: 2025-09-10 00:30:00 +0000
categories: kubernetes
tags: [kubernetes, ingress, multi-cluster, istio, nginx, cert-manager, tls]
excerpt: "대규모 서비스를 위한 멀티 클러스터 Ingress 아키텍처 설계와 Istio, cert-manager를 활용한 고가용성 트래픽 관리 전략을 실무 경험을 바탕으로 다룹니다."
---

# Kubernetes 멀티 클러스터 Ingress 아키텍처 설계

대규모 서비스에서는 **단일 클러스터로는 한계**가 있습니다. 지리적 분산, 장애 격리, 트래픽 분산 등의 이유로 멀티 클러스터 환경이 필수가 되었습니다. 이번 포스트에서는 멀티 클러스터 환경에서 효율적인 Ingress 아키텍처 설계와 Istio, cert-manager를 활용한 실무적인 구현 방법을 다루겠습니다.

<!--more-->

## 핵심 구성 요소 이해

### Ingress Controller
클러스터 외부에서 내부 서비스로 HTTP/HTTPS 트래픽을 **라우팅하는 진입점**입니다. 로드밸런싱, SSL 터미네이션, 경로 기반 라우팅 등의 기능을 제공합니다.

### Istio Service Mesh
마이크로서비스 간 통신을 관리하는 **인프라 계층**으로, 멀티 클러스터 환경에서 서비스 디스커버리, mTLS, 트래픽 관리를 통합적으로 제공합니다.

### cert-manager
Kubernetes에서 **TLS 인증서를 자동으로 발급, 갱신**하는 도구로, Let's Encrypt 등의 CA와 연동하여 인증서 라이프사이클을 관리합니다.

## 멀티 클러스터 Ingress 설계 패턴

### 1. 안티패턴: NodePort + 외부 LB (지양)

```
External LB → NodePort → kube-proxy → Service → Pod
     ↑         ↑           ↑
   SPOF    추가 홉    노드 장애점
```

**문제점:**
- 외부 LB 하나가 단일 장애점(SPOF)
- kube-proxy를 통한 추가 네트워크 홉
- 각 노드가 장애점이 될 수 있음

### 2. 권장: 도메인 기반 멀티 LB 구성

```
Internet
    ↓
┌─────────────────────────────────────────────┐
│               DNS Layer                     │
│  ┌─────────────┐    ┌─────────────┐        │
│  │ portal.com  │    │ api.com     │        │
│  └─────────────┘    └─────────────┘        │
└─────────────────────────────────────────────┘
    ↓                        ↓
┌─────────────────┐    ┌─────────────────┐
│  Gateway        │    │  API             │
│  Cluster        │    │  Cluster         │
│                 │    │                  │
│ ┌─────────────┐ │    │ ┌─────────────┐  │
│ │   Portal    │ │    │ │   API       │  │
│ │   Services  │ │    │ │   Services  │  │
│ └─────────────┘ │    │ └─────────────┘  │
└─────────────────┘    └─────────────────┘
```

**장점:**
- 도메인별 장애 격리
- 클러스터별 독립적인 LB
- URI 경로로 서비스 구분 가능

## Istio 멀티 클러스터 구성

### Primary-Remote 아키텍처

```
Cluster 1 (Primary HA)        Cluster 2 (Remote)
┌─────────────────────────────┐   ┌─────────────────┐
│  ┌─────────┐  ┌─────────┐   │   │                 │
│  │istiod-1 │  │istiod-2 │───┼───┼─► Envoy Proxies │
│  └─────────┘  └─────────┘   │   │                 │
│  │istiod-3 │                │   │                 │
│  └─────────┘                │   │                 │
│         Envoy Proxies       │   │                 │
└─────────────────────────────┘   └─────────────────┘
```

### Primary 클러스터 설치 (HA 구성)

```bash
# HA istiod 설치 (replica 3개)
istioctl install \
  --set values.pilot.env.ISTIOD_ENABLE_WORKLOAD_ENTRY_AUTOREGISTRATION=true \
  --set values.pilot.replicaCount=3 \
  --set values.global.meshID=mesh1

# Anti-affinity로 각기 다른 노드에 배포
kubectl patch deployment istiod -n istio-system -p '{
  "spec": {
    "template": {
      "spec": {
        "affinity": {
          "podAntiAffinity": {
            "requiredDuringSchedulingIgnoredDuringExecution": [
              {
                "labelSelector": {
                  "matchLabels": {
                    "app": "istiod"
                  }
                },
                "topologyKey": "kubernetes.io/hostname"
              }
            ]
          }
        }
      }
    }
  }
}'
```

### 네트워크 및 Gateway 설정

**클러스터 간 mTLS 통신을 위한 Cross-network Gateway와 istiod 외부 노출 설정**

```yaml
# Primary 클러스터 네트워크 설정
apiVersion: networking.istio.io/v1alpha3
kind: Gateway
metadata:
  name: cross-network-gateway
  namespace: istio-system
spec:
  selector:
    istio: eastwestgateway
  servers:
  - port:
      number: 15443
      name: tls
      protocol: TLS
    tls:
      mode: ISTIO_MUTUAL
    hosts:
    - "*.local"
---
# Remote 클러스터를 위한 istiod 노출
apiVersion: networking.istio.io/v1alpha3
kind: Gateway
metadata:
  name: istiod-gateway
  namespace: istio-system
spec:
  selector:
    istio: ingressgateway
  servers:
  - port:
      number: 15012
      name: grpc-istiod
      protocol: GRPC
    hosts:
    - "*"
---
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: istiod-virtualservice
  namespace: istio-system
spec:
  hosts:
  - "*"
  gateways:
  - istiod-gateway
  http:
  - match:
    - port: 15012
    route:
    - destination:
        host: istiod
        port:
          number: 15012
```

### Remote 클러스터 구성

```bash
# Primary 클러스터의 CA 인증서 추출 및 복사
kubectl get configmap istio-ca-root-cert -n istio-system -o yaml > ca-root-cert.yaml
kubectl apply -f ca-root-cert.yaml --context=cluster2

# Primary 클러스터의 istiod 주소 확인
DISCOVERY_ADDRESS=$(kubectl get svc istio-ingressgateway -n istio-system \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# Remote Istio 설치
istioctl install --context=cluster2 \
  --set values.istiodRemote.enabled=true \
  --set values.pilot.env.EXTERNAL_ISTIOD=true \
  --set values.global.meshID=mesh1 \
  --set values.global.network=network2 \
  --set values.global.remotePilotAddress=${DISCOVERY_ADDRESS} \
  --set values.gateways.istio-ingressgateway.enabled=false

# Primary에서 Remote 클러스터 접근을 위한 Secret
kubectl create secret generic cluster2-secret \
  --from-file=cluster2=/path/to/cluster2/kubeconfig \
  -n istio-system
kubectl label secret cluster2-secret istio/cluster=cluster2 -n istio-system

# Remote 클러스터 네트워크 레이블
kubectl label namespace istio-system topology.istio.io/network=network2 --context=cluster2
```

### Remote 클러스터에서는 istiod가 실행되지 않나요?

맞습니다. Primary-Remote 아키텍처에서 Remote 클러스터는 자체 istiod 없이 Primary 클러스터의 istiod에서 관리됩니다. 이렇게 하면 관리 포인트가 줄어들고, 인증서 관리가 중앙집중화되며, 서비스 디스커버리 동기화가 쉬워집니다. Remote 클러스터에는 Envoy Proxy(데이터 플레인)만 실행됩니다.

### 고가용성을 위한 PDB 설정

**istiod 3개 중 최소 2개는 항상 실행 상태를 유지하는 PDB**

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: istiod-pdb
  namespace: istio-system
spec:
  minAvailable: 2                # 3개 중 최소 2개 유지
  selector:
    matchLabels:
      app: istiod
```

## TLS 인증서 관리 전략

### 멀티 클러스터 cert-manager 체크리스트

- [ ] cert-manager가 모든 클러스터에 설치됨
- [ ] DNS 공급자 Secret이 모든 클러스터에 생성됨  
- [ ] ClusterIssuer가 모든 클러스터에서 Ready 상태
- [ ] Certificate가 성공적으로 발급됨 (Ready=True)
- [ ] Secret이 생성되고 인증서 데이터가 있음
- [ ] Ingress에서 올바른 Secret을 참조함
- [ ] DNS 레코드가 각 클러스터 LoadBalancer를 가리킴
- [ ] HTTPS로 접속이 되고 인증서가 유효함

### DNS-01 Challenge를 활용한 와일드카드 인증서

HTTP-01 Challenge는 멀티 클러스터 환경에서 복잡하므로 DNS-01을 권장합니다.

```yaml
# Route53 DNS-01 Challenge를 사용하는 Let's Encrypt ClusterIssuer
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-wildcard
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-wildcard
    solvers:
    - dns01:
        route53:                # AWS Route53 사용 시
          region: us-east-1
          accessKeyID: AKIA...
          secretAccessKeySecretRef:
            name: route53-secret
            key: secret-access-key
```

### 와일드카드 인증서 활용 패턴

**패턴 1: Certificate 리소스로 관리**

***.example.com 와일드카드 인증서 생성 후 여러 Ingress에서 공유 사용**

```yaml
# 인증서 생성
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-cert
  namespace: shared-certs
spec:
  secretName: wildcard-tls
  issuerRef:
    name: letsencrypt-wildcard
    kind: ClusterIssuer
  dnsNames:
  - "*.example.com"
  - "example.com"
---
# 여러 Ingress에서 공유 사용
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: api
spec:
  tls:
  - hosts:
    - api.example.com
    - admin.example.com
    secretName: wildcard-tls    # 공유 인증서 참조
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /v1
        pathType: Prefix
        backend:
          service:
            name: api-v1-service
            port:
              number: 80
```

**패턴 2: Ingress Annotation 자동 생성**

**cert-manager.io/cluster-issuer 어노테이션으로 인증서 자동 생성**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: auto-cert-ingress
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-wildcard"  # 자동 인증서 생성
spec:
  tls:
  - hosts:
    - myapp.example.com
    secretName: myapp-tls       # cert-manager가 자동 생성
  rules:
  - host: myapp.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: myapp-service
            port:
              number: 80
```

### cert-manager Annotation 방식과 Certificate 리소스 방식 중 어느 것이 나을까?

둘 다 장단점이 있습니다. Annotation 방식은 간편하지만 인증서를 여러 Ingress에서 공유하기 어렵고, 인증서 라이프사이클 관리가 제한적입니다. Certificate 리소스 방식은 인증서를 중앙에서 관리할 수 있고, 여러 네임스페이스에서 공유 가능하며, 복잡한 설정도 가능합니다. 대규모 환경에서는 Certificate 리소스 방식을 권장합니다.

## Ingress 보안 강화

### NGINX Ingress Controller 보안 설정

**HTTPS 리다이렉트, Rate Limiting, WAF 등 종합 보안 강화 Ingress 설정**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: secure-ingress
  annotations:
    # HTTPS 강제 리다이렉트
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    
    # HSTS 헤더 설정
    nginx.ingress.kubernetes.io/server-snippet: |
      add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    
    # Rate Limiting
    nginx.ingress.kubernetes.io/rate-limit: "100"            # 분당 100 요청
    nginx.ingress.kubernetes.io/rate-limit-window: "1m"
    nginx.ingress.kubernetes.io/rate-limit-rps: "10"         # 초당 10 요청
    nginx.ingress.kubernetes.io/rate-limit-connections: "20" # 동시 연결 20개
    
    # 경로별 차등 제한
    nginx.ingress.kubernetes.io/server-snippet: |
      location /api/ {
        limit_req zone=api burst=50 nodelay;
      }
      location /upload/ {
        limit_req zone=upload burst=5 nodelay;
      }
    
    # IP 화이트리스트
    nginx.ingress.kubernetes.io/whitelist-source-range: "10.0.0.0/8,172.16.0.0/12"
    
    # WAF (ModSecurity) 활성화
    nginx.ingress.kubernetes.io/enable-modsecurity: "true"
    nginx.ingress.kubernetes.io/modsecurity-snippet: |
      SecRuleEngine On
      SecRule ARGS "@detectSQLi" "id:1001,phase:2,block"
      SecRule ARGS "@detectXSS" "id:1002,phase:2,block"
spec:
  tls:
  - hosts:
    - secure.example.com
    secretName: secure-tls
  rules:
  - host: secure.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: secure-service
            port:
              number: 80
```

## 트래픽 라우팅 전략

### 호스트 기반 라우팅 (권장)

**관리자/사용자/API 서비스를 서브도메인별로 분리하는 멀티 호스트 Ingress**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: multi-service-ingress
spec:
  tls:
  - hosts:
    - admin.example.com
    - user.example.com
    - api.example.com
    secretName: wildcard-example-tls
  rules:
  # 관리자 서비스
  - host: admin.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: admin-service
            port:
              number: 80
  # 사용자 서비스  
  - host: user.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: user-service
            port:
              number: 80
  # API 서비스 (경로 기반 세분화)
  - host: api.example.com
    http:
      paths:
      - path: /v1
        pathType: Prefix
        backend:
          service:
            name: api-v1-service
            port:
              number: 80
      - path: /v2
        pathType: Prefix
        backend:
          service:
            name: api-v2-service
            port:
              number: 80
```

## 모니터링 및 관리

### Istio 모니터링

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: istiod-monitor
  namespace: istio-system
spec:
  selector:
    matchLabels:
      app: istiod
  endpoints:
  - port: http-monitoring
    interval: 15s
    path: /stats/prometheus
```

### 운영 명령어

```bash
# Istio 연결 상태 확인
istioctl proxy-status

# Remote 클러스터 연결 확인
kubectl get endpoints -n istio-system

# 인증서 상태 확인
kubectl get certificates -A
kubectl describe certificate wildcard-cert

# Ingress 상태 확인
kubectl get ingress -A
kubectl describe ingress secure-ingress
```

### 트러블슈팅 가이드

**문제 1: Remote 클러스터에서 istiod 연결 실패**
```bash
# Primary 클러스터의 istiod 서비스 확인
kubectl get svc -n istio-system | grep istiod

# Remote 클러스터 로그 확인
kubectl logs -l app=istio-proxy -n istio-system --context=cluster2

# 네트워크 연결 테스트
kubectl exec -it <pod-name> -n istio-system -- curl -v istiod.istio-system:15010/ready
```

**문제 2: 인증서 발급 실패**
```bash
# Certificate 리소스 상태 확인
kubectl describe certificate <cert-name>

# cert-manager 로그 확인
kubectl logs -n cert-manager deployment/cert-manager

# DNS Challenge 확인
kubectl get challenges
kubectl describe challenge <challenge-name>
```

**문제 3: Ingress 트래픽 라우팅 문제**
```bash
# Ingress Controller 로그 확인
kubectl logs -n ingress-nginx deployment/nginx-ingress-controller

# Backend 서비스 상태 확인
kubectl get endpoints <service-name>

# DNS 레코드 확인
nslookup <hostname>
```

## 비용 및 성능 최적화

### 리소스 효율성

```yaml
# Ingress Controller 리소스 최적화
resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "1000m" 
    memory: "1Gi"

# HPA 설정
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: nginx-ingress-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: nginx-ingress-controller
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

### 캐싱 전략

```yaml
annotations:
  # 정적 리소스 캐싱
  nginx.ingress.kubernetes.io/server-snippet: |
    location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
      expires 1y;
      add_header Cache-Control "public, immutable";
    }
    
    # API 응답 캐싱
    location /api/v1/static/ {
      expires 1h;
      add_header Cache-Control "public";
    }
```

### Rate Limiting을 너무 낮게 설정하면 정상 사용자도 차단되지 않을까?

맞습니다. Rate Limiting 값은 실제 트래픽 패턴을 분석해서 설정해야 합니다. 위 예시의 "분당 100 요청, 초당 10 요청"은 일반적인 가이드라인이고, API 엔드포인트별로 다르게 설정하는 것이 좋습니다. 예를 들어 이미지 업로드는 더 엄격하게, 정적 리소스는 더 관대하게 설정할 수 있습니다. 또한 burst 파라미터로 일시적인 트래픽 급증도 허용할 수 있습니다.

다음 포스트에서는 **"Kubernetes 보안 강화: RBAC, Security Context, Network Policy"**에 대해 다루겠습니다.