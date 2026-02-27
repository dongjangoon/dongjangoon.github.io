---
layout: single
title: "Kubernetes 보안 강화: RBAC, Security Context, Network Policy"
date: 2025-09-10 01:00:00 +0000
last_modified_at: 2025-09-14
categories: kubernetes
tags: [kubernetes, rbac, security, network-policy, pod-security, zero-trust]
excerpt: "Zero Trust 아키텍처 구현을 위한 Kubernetes RBAC, Security Context, Network Policy 설정과 실무에서 검증된 보안 강화 전략을 상세히 다룹니다."
---

# Kubernetes 보안 강화: RBAC, Security Context, Network Policy

Kubernetes 클러스터는 기본적으로 **"모든 것이 허용"**되는 구조입니다. 프로덕션 환경에서는 **Zero Trust 원칙**에 따라 명시적으로 허용된 것만 실행되도록 보안을 강화해야 합니다. 이번 포스트에서는 RBAC, Security Context, Network Policy를 활용한 종합적인 보안 강화 전략을 실무 경험을 바탕으로 다루겠습니다.

<!--more-->

## 핵심 보안 구성 요소 이해

### RBAC (Role-Based Access Control)
**"누가 무엇을 할 수 있는가"**를 제어하는 권한 관리 시스템입니다. ServiceAccount, Role/ClusterRole, RoleBinding/ClusterRoleBinding으로 구성되어 최소 권한 원칙을 구현합니다.

### Security Context
**"파드와 컨테이너가 어떤 보안 설정으로 실행되는가"**를 제어합니다. 사용자 권한, 파일 시스템 접근, Linux Capabilities 등을 세밀하게 관리합니다.

### Network Policy
**"파드 간 네트워크 통신을 어떻게 제한할 것인가"**를 정의합니다. 기본적으로 모든 통신이 허용되는 Kubernetes에서 네트워크 수준의 마이크로세그멘테이션을 구현합니다.

### Pod Security Standards
Kubernetes 1.23+에서 도입된 **파드 보안 정책의 표준화된 프로파일**입니다. Privileged, Baseline, Restricted 세 가지 레벨로 보안 수준을 정의합니다.

## Kubernetes 보안 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                    Cluster Level                           │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │ RBAC            │    │ Pod Security    │                │
│  │ Authorization   │    │ Standards       │                │
│  └─────────────────┘    └─────────────────┘                │
└─────────────────────────────────────────────────────────────┘
           │                            │
           ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Namespace Level                         │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │ Network Policy  │    │ Resource Quotas │                │
│  │ Micro-segment   │    │ Limits          │                │
│  └─────────────────┘    └─────────────────┘                │
└─────────────────────────────────────────────────────────────┘
           │                            │
           ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Pod Level                               │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │ Security        │    │ Secret          │                │
│  │ Context         │    │ Management      │                │
│  └─────────────────┘    └─────────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

## 1. RBAC 구성과 최소 권한 원칙

### ServiceAccount 기반 권한 관리

**애플리케이션별 전용 ServiceAccount와 명시적 토큰 마운팅 설정**

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-service-account
  namespace: production
automountServiceAccountToken: true    # 명시적 설정 (보안 고려)
```

### ClusterRole vs Role 설계 원칙

**클러스터 전체에서 파드와 노드 정보를 읽기 전용으로 접근하는 ClusterRole**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pod-reader
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "list", "watch"]       # 읽기 전용 권한
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "list"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets"]
  verbs: ["get", "list", "watch"]
```

**특정 네임스페이스 내에서 시크릿과 설정 관리 권한을 가진 Role**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: production
  name: secret-configmap-manager
rules:
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "create", "update", "patch"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch", "create", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  resourceNames: ["my-deployment"]      # 특정 리소스만 제한
```

### 권한 바인딩 전략

**ServiceAccount, 사용자, 그룹을 모두 포함한 ClusterRoleBinding**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: pod-reader-binding
subjects:
- kind: ServiceAccount
  name: app-service-account
  namespace: production
- kind: User
  name: jane@example.com              # OIDC 사용자
  apiGroup: rbac.authorization.k8s.io
- kind: Group
  name: developers                    # OIDC 그룹
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

**네임스페이스 범위 권한을 특정 사용자와 ServiceAccount에 부여**

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: secret-manager-binding
  namespace: production
subjects:
- kind: ServiceAccount
  name: app-service-account
  namespace: production
- kind: User
  name: admin@example.com
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: secret-configmap-manager
  apiGroup: rbac.authorization.k8s.io
```

### ClusterRole은 꼭 ClusterRoleBinding하고만 묶여야 할까?

혹시 이름이 같아서 그렇게 생각할 수 있지만, 그건 아닙니다. 오히려 ClusterRole의 특정 네임스페이스에서 재사용하기 위해 RoleBinding과 ClusterRole이 바인딩되는 경우도 많습니다. 

## 2. Security Context를 활용한 컨테이너 보안

### 포괄적 보안 설정이 적용된 프로덕션 Deployment

**Non-root 실행, 읽기 전용 파일시스템, 모든 Capabilities 제거한 강화된 보안 설정**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-webapp
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: secure-webapp
  template:
    metadata:
      labels:
        app: secure-webapp
    spec:
      serviceAccountName: app-service-account
      
      # Pod Security Context - 파드 전체 보안 설정
      securityContext:
        runAsNonRoot: true                # non-root 사용자 강제
        runAsUser: 1000                   # 특정 사용자 ID 지정
        runAsGroup: 1000                  # 특정 그룹 ID 지정
        fsGroup: 2000                     # 파일 시스템 소유 그룹
        seccompProfile:
          type: RuntimeDefault            # Seccomp 프로파일 적용
          
      containers:
      - name: webapp
        image: registry.example.com/webapp:v1.2.3
        
        # Container Security Context - 컨테이너별 보안 설정
        securityContext:
          readOnlyRootFilesystem: true            # 읽기 전용 루트 파일 시스템
          allowPrivilegeEscalation: false         # 권한 상승 방지
          privileged: false                       # 특권 컨테이너 금지
          capabilities: 
            drop: 
            - ALL                                 # 모든 Linux Capabilities 제거
          runAsUser: 1001                        # 컨테이너별 사용자 (Pod 설정 오버라이드)
          runAsGroup: 1001
          
        # 환경변수를 Secret에서 안전하게 로드
        envFrom:
        - secretRef:
            name: app-secrets
            
        # 읽기 전용 파일 시스템을 위한 필수 마운트
        volumeMounts:
        - name: tmp-volume 
          mountPath: /tmp                         # 임시 파일용 쓰기 가능 영역
        - name: app-data
          mountPath: /app/data                    # 애플리케이션 데이터용
          
      volumes:
      - name: tmp-volume
        emptyDir: {}
      - name: app-data
        emptyDir: {}
```

### Security Context 설정 가이드

| 설정 | 효과 | 권장 값 |
|------|------|---------|
| `runAsNonRoot` | root 실행 방지 | `true` |
| `readOnlyRootFilesystem` | 파일 시스템 변조 방지 | `true` |
| `allowPrivilegeEscalation` | 권한 상승 방지 | `false` |
| `capabilities.drop` | 불필요한 권한 제거 | `["ALL"]` |
| `seccompProfile.type` | 시스템 콜 제한 | `RuntimeDefault` |

### readOnlyRootFilesystem을 true로 하면 애플리케이션이 동작할까?

많은 애플리케이션들이 `/tmp`, `/var/log` 등에 임시 파일을 생성하므로 읽기 전용 파일시스템에서는 오류가 발생할 수 있습니다. 이 문제는 `emptyDir` 볼륨을 마운트해서 해결할 수 있습니다. 위 예시처럼 `/tmp`와 `/app/data` 경로를 별도 볼륨으로 마운트하면 애플리케이션이 필요한 곳에만 쓰기 권한을 제공할 수 있습니다.

## 3. Pod Security Standards 구현

### 환경별 보안 프로파일 적용

**개발 환경: 경고만 표시하는 유연한 정책**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: development
  labels:
    pod-security.kubernetes.io/warn: baseline      # 경고만 표시
    pod-security.kubernetes.io/audit: restricted   # 감사 로그는 엄격하게
```

**프로덕션 환경: 엄격한 보안 정책 강제 적용**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted  # 정책 강제 적용
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
```

**시스템 모니터링: 특권 컨테이너 허용**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: system-monitoring
  labels:
    pod-security.kubernetes.io/enforce: privileged  # 시스템 컴포넌트용
```

### 보안 프로파일 레벨

| 레벨 | 설명 | 사용 사례 |
|------|------|-----------|
| **Privileged** | 제한 없음 | 시스템 컴포넌트, 모니터링 도구 |
| **Baseline** | 기본적인 보안 적용 | 개발 환경, 레거시 애플리케이션 |
| **Restricted** | 엄격한 보안 적용 | 프로덕션 환경, 민감한 워크로드 |

### Pod Security Standards는 어떻게 동작할까?

네임스페이스에 설정된 라벨에 따라 파드 생성 시점에 보안 검증이 수행됩니다. `enforce`는 정책 위반 시 파드 생성을 차단하고, `warn`은 경고만 표시하며, `audit`은 위반 사항을 감사 로그에 기록합니다. 이 방식은 기존 PSP(Pod Security Policy)보다 훨씬 간단하고 관리하기 쉽습니다.

## 4. Network Policy를 활용한 네트워크 보안

### 기본 보안 설정: 최소 권한 네트워크 정책

**DNS와 HTTPS만 허용하고 클러스터 내부 통신을 제어하는 기본 정책**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: essential-security
  namespace: production
spec:
  podSelector: {}                    # 네임스페이스 내 모든 파드에 적용
  policyTypes:
  - Egress
  egress:
  # 클러스터 내부 통신 허용
  - to:
    - namespaceSelector: {}
  # DNS 허용 (필수)
  - to: []
    ports:
    - protocol: UDP
      port: 53
  # HTTPS 외부 통신 허용
  - to: []
    ports:
    - protocol: TCP
      port: 443
```

### 마이크로서비스 간 통신 제어

**프론트엔드에서 백엔드 API로만 통신을 허용하는 정책**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-access-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: backend-api              # 백엔드 API 파드 선택
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend             # 프론트엔드에서만 접근 허용
    ports:
    - protocol: TCP
      port: 8080
```

**데이터베이스 접근 제한 정책**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: database-access-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: postgresql
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          role: backend             # 백엔드 역할을 가진 파드만 허용
    ports:
    - protocol: TCP
      port: 5432
```

### 네임스페이스 간 통신 제어

**특정 네임스페이스에서만 접근을 허용하는 정책**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cross-namespace-policy
  namespace: shared-services
spec:
  podSelector:
    matchLabels:
      app: redis
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: production          # 프로덕션 네임스페이스만 허용
    - namespaceSelector:
        matchLabels:
          name: staging             # 스테이징 네임스페이스만 허용
    ports:
    - protocol: TCP
      port: 6379
```

### Network Policy가 없으면 어떻게 될까?

Kubernetes는 기본적으로 모든 파드 간 통신이 허용되는 "flat network" 구조입니다. Network Policy가 없다면 해커가 하나의 파드를 장악했을 때 클러스터 내 모든 서비스에 접근할 수 있어서 lateral movement 공격에 매우 취약합니다. 따라서 Zero Trust 환경에서는 반드시 Network Policy로 마이크로세그멘테이션을 구현해야 합니다.

## 5. Secret 관리와 보안

### 다양한 유형의 Secret 관리

**애플리케이션 설정을 위한 일반적인 Secret**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
  namespace: production
type: Opaque
data:
  # base64 인코딩된 민감한 데이터
  database-url: cG9zdGdyZXNxbDovL3VzZXI6cGFzc0BkYi5leGFtcGxlLmNvbS9teWRi
  api-key: YWJjZGVmZ2hpams=
stringData:
  # 평문 입력 (자동으로 base64 인코딩됨)
  redis-url: "redis://redis.example.com:6379"
  smtp-host: "smtp.gmail.com"
```

**TLS 인증서 Secret**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: tls-secret
  namespace: production
type: kubernetes.io/tls
data:
  tls.crt: LS0tLS1CRUdJTi...        # base64 인코딩된 인증서
  tls.key: LS0tLS1CRUdJTi...        # base64 인코딩된 개인키
```

**프라이빗 컨테이너 레지스트리 접근용 Secret**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: docker-registry-secret
  namespace: production
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: eyJhdXRocyI6eyJyZWdpc3RyeS5leGFtcGxlLmNvbSI6eyJ1c2VybmFtZSI6InVzZXIiLCJwYXNzd29yZCI6InBhc3MiLCJhdXRoIjoiZFhObGNqcHdZWE56In19fQ==
```

### Secret 사용 시 보안 고려사항

```yaml
# Deployment에서 Secret 안전하게 사용
spec:
  template:
    spec:
      containers:
      - name: app
        # 환경변수로 전체 Secret 로드
        envFrom:
        - secretRef:
            name: app-secrets
        # 특정 키만 환경변수로 로드  
        env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: database-password
        # 파일로 마운트 (더 안전함)
        volumeMounts:
        - name: secret-volume
          mountPath: "/etc/secrets"
          readOnly: true
      volumes:
      - name: secret-volume
        secret:
          secretName: app-secrets
          defaultMode: 0400              # 읽기 전용 권한
```

### Secret을 환경변수로 사용하는 것과 파일로 마운트하는 것 중 어느 쪽이 더 안전할까?

파일로 마운트하는 것이 더 안전합니다. 환경변수는 `ps` 명령어나 프로세스 정보로 노출될 가능성이 있고, 로그에 실수로 출력될 수 있습니다. 반면 파일로 마운트하면 파일 권한(0400)으로 접근을 제어할 수 있고, 메모리에만 존재해서 더 안전합니다. 단, 애플리케이션이 파일 읽기를 지원해야 합니다.

## 6. 통합 보안 모니터링

### 보안 이벤트 모니터링

**RBAC 권한 위반과 보안 정책 위반을 탐지하는 Prometheus 규칙**

```yaml
groups:
- name: kubernetes-security
  rules:
  - alert: UnauthorizedAPIAccess
    expr: increase(apiserver_audit_total{verb!~"get|list|watch"}[5m]) > 10
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: "Unusual API access pattern detected"
      
  - alert: PrivilegedPodCreated
    expr: increase(kube_pod_container_status_restarts_total{container=~".*privileged.*"}[5m]) > 0
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "Privileged container detected"
      
  - alert: NetworkPolicyViolation
    expr: increase(network_policy_drop_total[5m]) > 50
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "High number of network policy violations"
```

### 보안 감사 체크리스트

#### 📋 **RBAC 보안 검증**
- [ ] 모든 ServiceAccount에 명시적 권한 부여
- [ ] 불필요한 cluster-admin 권한 제거
- [ ] 네임스페이스별 권한 분리 구현
- [ ] 정기적 권한 검토 및 정리

#### 📋 **Pod 보안 검증**
- [ ] 모든 컨테이너 non-root 실행
- [ ] readOnlyRootFilesystem 적용
- [ ] 모든 Capabilities 제거 (drop: ALL)
- [ ] Pod Security Standards 적용

#### 📋 **네트워크 보안 검증**
- [ ] Default-deny NetworkPolicy 구현
- [ ] 마이크로서비스 간 통신 제한
- [ ] 외부 통신 최소화 (DNS, HTTPS만)
- [ ] 네임스페이스 간 격리 구현

#### 📋 **Secret 관리 검증**
- [ ] Secret 파일 마운트 우선 사용
- [ ] Secret 접근 권한 최소화
- [ ] 정기적 Secret 로테이션
- [ ] Secret 암호화 저장 확인

## 실무 트러블슈팅

### 권한 문제 해결

```bash
# ServiceAccount 권한 확인
kubectl auth can-i create pods --as=system:serviceaccount:production:app-service-account

# 사용자 권한 확인
kubectl auth can-i get secrets --as=jane@example.com -n production

# RBAC 권한 디버깅
kubectl describe clusterrolebinding pod-reader-binding
```

### Network Policy 디버깅

```bash
# NetworkPolicy 상태 확인
kubectl get networkpolicy -A

# Pod 간 통신 테스트
kubectl exec -it frontend-pod -- curl backend-service:8080

# 네트워크 플러그인 로그 확인 (Calico 예시)
kubectl logs -n kube-system -l k8s-app=calico-node
```

## 결론

Kubernetes 보안은 **다층 방어(Defense in Depth)** 전략으로 접근해야 합니다.

### 핵심 보안 원칙
1. **최소 권한 원칙**: 필요한 최소한의 권한만 부여
2. **네트워크 분할**: 마이크로세그멘테이션으로 공격 범위 축소  
3. **런타임 보안**: 컨테이너 실행 시점의 보안 강화
4. **지속적 모니터링**: 보안 이벤트 실시간 탐지

### 구현 우선순위
1. **Pod Security Standards** 적용 → 기본 보안 확보
2. **RBAC** 구현 → 권한 기반 접근 제어
3. **Network Policy** 설정 → 네트워크 레벨 격리
4. **Security Context** 강화 → 컨테이너 보안 심화

Zero Trust 보안 모델에서 **"신뢰하지 말고 검증하라"**는 원칙을 Kubernetes 환경에서 구현하는 것이 현대적 보안 전략의 핵심입니다.

다음 포스트에서는 **"Kubernetes 운영 최적화: 스토리지, NTP, 프로브 설정"**에 대해 다루겠습니다.