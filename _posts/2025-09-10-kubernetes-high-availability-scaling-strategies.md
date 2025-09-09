---
layout: post
title: "Kubernetes 고가용성과 안정성 확보: HPA, PDB, 스케일링 전략"
date: 2025-09-10 00:00:00 +0000
categories: [kubernetes, infrastructure]
tags: [kubernetes, hpa, pdb, scaling, high-availability, cluster-autoscaler]
excerpt: "프로덕션 Kubernetes 환경에서 HPA, PDB, Cluster Autoscaler를 활용한 고가용성과 안정적인 스케일링 전략을 실무 경험을 바탕으로 상세히 다룹니다."
---

# Kubernetes 고가용성과 안정성 확보: HPA, PDB, 스케일링 전략

프로덕션 Kubernetes 환경에서 가장 중요한 것 중 하나는 **서비스의 안정성과 가용성**입니다. 트래픽 급증이나 노드 장애 상황에서도 서비스가 중단되지 않도록 하는 것이 핵심입니다. 이번 포스트에서는 HPA(Horizontal Pod Autoscaler), PDB(PodDisruptionBudget), Cluster Autoscaler를 활용한 종합적인 고가용성 전략을 실무 관점에서 다루겠습니다.

<!--more-->

## 핵심 구성 요소 이해

### HPA (Horizontal Pod Autoscaler)
CPU, 메모리 등의 메트릭을 기반으로 **파드 수를 자동으로 조절**하는 컨트롤러입니다. 트래픽이 증가하면 파드를 늘리고, 감소하면 파드를 줄여서 리소스 효율성을 극대화합니다. 커스텀 메트릭을 통한 설정도 가능합니다.

### PDB (PodDisruptionBudget)
클러스터 유지보수나 노드 업그레이드 시 **동시에 중단될 수 있는 파드 수를 제한**하여 서비스 가용성을 보장합니다. 예를 들어 5개 파드 중 최소 3개는 항상 실행 상태를 유지하도록 설정할 수 있습니다.

### Cluster Autoscaler
파드가 스케줄링될 노드가 부족하거나 노드 사용률이 낮을 때 **클러스터의 노드 수를 자동으로 조절**합니다. HPA가 파드 레벨이라면, Cluster Autoscaler는 인프라 레벨의 오토스케일링을 담당합니다.

## 전체 아키텍처 개요

고가용성 Kubernetes 클러스터의 핵심 구성 요소들:

```
┌─────────────────────────────────────────────────────────────┐
│                    Cluster Level                           │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │ Cluster         │    │ Node            │                │
│  │ Autoscaler      │◄──►│ Autoscaler      │                │
│  └─────────────────┘    └─────────────────┘                │
└─────────────────────────────────────────────────────────────┘
           │                            │
           ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Node Level                              │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │ Resource        │    │ Pod             │                │
│  │ Management      │    │ Distribution    │                │
│  └─────────────────┘    └─────────────────┘                │
└─────────────────────────────────────────────────────────────┘
           │                            │
           ▼                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Pod Level                               │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │ HPA             │◄──►│ PDB             │                │
│  │ (Scale Out/In)  │    │ (Disruption)    │                │
│  └─────────────────┘    └─────────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

## 1. HPA(Horizontal Pod Autoscaler) 최적화

### 리소스 기반 HPA 전략

실무에서 검증된 HPA 설정 원칙입니다:

**CPU 60%, 메모리 65% 임계치로 3-35개 파드 자동 스케일링 설정**

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: production-app-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: production-app
  minReplicas: 3                    # 최소 가용성 보장
  maxReplicas: 35                   # 리소스 계산 기반 상한선
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60      # 노드 70% 제한을 고려한 설정
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 65      # 메모리는 약간 높게 설정
  behavior:                         # 스케일링 동작 제어
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 100
        periodSeconds: 30
```

### 실무 리소스 계산 방법

**클러스터 사양 예시:**
- 전체 용량: 128코어, 512GB
- 70% 활용 제한: 89.6코어, 358.4GB
- 파드당 리소스: 2코어, 8GB
- 이론적 최대: 44개 파드
- **안전 마진 적용: HPA Max 35개** (시스템 파드 고려)

**파드 당 1.5CPU, 6-8GB 메모리로 리소스 요청/제한 설정**

```yaml
# Deployment 리소스 설정
resources:
  requests:
    memory: "6Gi"           # 실제 사용량 기준
    cpu: "1500m"
  limits:
    memory: "8Gi"           # 버퍼 포함
    cpu: "2000m"
```

### GPU 워크로드 스케일링 전략

AI/ML 워크로드를 위한 특별한 고려사항

- 아래는 예시 설정입니다
- 하지만 설정 자체는 비슷합니다. GPU 노드에는 GPU 서비스들만 배포되어야 하므로 nodeSelector, taint, toleration이 필수입니다.

**GPU 노드 전용 스케줄링과 리소스 분산을 위한 ML 서비스 배포 설정**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ml-training-service
  namespace: ml-workloads
spec:
  replicas: 2
  template:
    spec:
      # GPU 노드 전용 스케줄링
      nodeSelector:
        workload-type: ai-ml
        gpu-memory-gb: "32"
      
      # GPU 노드 톨러레이션
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      - key: gpu-workload
        operator: Equal
        value: "true"
        effect: NoSchedule
      
      # 균등 분산을 위한 제약
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: accelerator-type
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            accelerator-type: gpu
      
      containers:
      - name: ml-training
        image: tensorflow/tensorflow:2.13.0-gpu
        resources:
          requests:
            memory: "8Gi"
            cpu: "2000m"
            nvidia.com/gpu: 1
          limits:
            memory: "16Gi"
            cpu: "4000m"
            nvidia.com/gpu: 1
```

## 2. PDB(PodDisruptionBudget)로 가용성 보장

### PDB 설정 패턴

**1. 고가용성 웹 애플리케이션**

**5개 파드 중 최소 2개는 항상 실행 상태를 유지하는 PDB 설정**

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-app-pdb
  namespace: production
spec:
  minAvailable: 2           # 최소 2개 파드 항상 유지
  selector:
    matchLabels:
      app: web-app
---
# 대응하는 Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
spec:
  replicas: 5               # PDB minAvailable보다 충분히 큰 값
```

**2. 퍼센트 기반 PDB**

**전체 파드의 75% 이상을 항상 유지하는 퍼센트 기반 PDB**

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
spec:
  minAvailable: 75%         # 75% 이상 유지
  selector:
    matchLabels:
      tier: api-server
```

**3. StatefulSet을 위한 PDB**

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: database-pdb
spec:
  maxUnavailable: 1         # 한 번에 하나씩만 재시작
  selector:
    matchLabels:
      app: postgresql
```

### HPA와 PDB 연동 최적화

```yaml
# HPA 설정
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-hpa
spec:
  minReplicas: 3
  maxReplicas: 10
  
---
# 대응하는 PDB 설정
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-pdb
spec:
  minAvailable: 2           # HPA minReplicas(3)보다 작게 설정
  selector:
    matchLabels:
      app: web
```

### PDB와 HPA를 같이 사용할 때 주의할 점은?

PDB의 `minAvailable`은 HPA의 `minReplicas`보다 작게 설정해야 합니다. 만약 둘이 같다면 롤링 업데이트 시 새로운 파드를 생성할 공간이 없어서 업데이트가 중단될 수 있습니다. 위 예시처럼 HPA minReplicas가 3이면 PDB minAvailable은 2로 설정하는 것이 안전합니다.

**⚠️ PDB 설정 주의사항:**

```yaml
# ❌ 위험한 설정 (데드락 발생 가능)
replicas: 3
minAvailable: 3             # 롤링 업데이트 불가능

# ✅ 안전한 설정
replicas: 5
minAvailable: 3             # 업데이트 중에도 가용성 보장
```

## 3. Cluster Autoscaler 운영 전략

### 기본 설정 값 최적화

| 설정 항목 | 권장 값 | 사유 |
|-----------|---------|------|
| 최소 노드 수 | 3 | 다중 AZ 분산 |
| 최대 노드 수 | 10 | 비용 제어 |
| 리소스 사용량 임계치 | 50% | 여유 있는 감축 |
| 임계 영역 유지 시간 | 10분 | 트래픽 패턴 고려 |
| 증설 후 감축 지연 시간 | 10분 | 파드 안정화 대기 |

### 노드 증설 및 감축 조건

**노드 증설 조건:**
- 파드가 스케줄링될 수 있는 노드가 없음
- 현재 노드 수 < 최대 노드 수

**노드 감축 조건:**
- 노드 리소스 사용량이 임계치(50%) 이하로 10분간 유지
- 현재 노드 수 > 최소 노드 수

**감축 제외 조건:**
- PodDisruptionBudget으로 제약받는 파드
- kube-system 네임스페이스의 파드
- 로컬 스토리지를 사용하는 파드
- Node Selector로 특정 노드에 고정된 파드

### Cluster Autoscaler가 노드를 감축하지 않는 경우는?

가장 흔한 이유는 해당 노드에 PDB로 보호받는 파드나 시스템 파드가 있기 때문입니다. 또한 로컬 볼륨을 사용하는 파드나 DaemonSet 파드가 있으면 해당 노드는 감축 대상에서 제외됩니다. 감축이 안 될 때는 `kubectl logs` 명령으로 cluster-autoscaler 로그를 확인해보세요.

### 모니터링 및 알람 설정

```yaml
groups:
- name: cluster-autoscaling
  rules:
  - alert: ClusterAutoscalerDown
    expr: up{job="cluster-autoscaler"} == 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Cluster Autoscaler is down"
      
  - alert: NodeUtilizationHigh
    expr: (1 - node_memory_available_bytes/node_memory_total_bytes) > 0.7
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Node memory utilization is high"
      
  - alert: TooManyPendingPods
    expr: kube_pod_status_phase{phase="Pending"} > 5
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Too many pods in Pending state"
      
  - alert: NodeScaleUpFailed
    expr: increase(cluster_autoscaler_failed_scale_ups_total[10m]) > 0
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "Node scale up has failed"
```

### 운영 명령어

```bash
# 스케일링 이벤트 조회
kubectl get events --field-selector reason="TriggeredScaleUp" -A
kubectl get events --field-selector reason="ScaleDown" -A

# Cluster Autoscaler 상태 확인
kubectl get configmap cluster-autoscaler-status -n kube-system -o yaml

# 노드별 리소스 사용률 확인
kubectl top nodes

# Pending 상태 파드 조회
kubectl get pods --field-selector=status.phase=Pending -A
```

## 4. 통합 운영 전략

### 단계별 스케일링 시나리오

**1단계: 트래픽 증가 감지**
```
정상 트래픽 → CPU 60% 도달 → HPA 파드 증설 시작
```

**2단계: 노드 리소스 부족**
```
파드 증설 → Pending 상태 발생 → Cluster Autoscaler 노드 증설
```

**3단계: 트래픽 감소**
```
트래픽 감소 → HPA 파드 감축 → 노드 사용률 50% 이하 → 노드 감축
```

### 실무 트러블슈팅 가이드

**문제 1: HPA가 스케일링하지 않음**
```bash
# 메트릭 서버 확인
kubectl get apiservice v1beta1.metrics.k8s.io

# HPA 상태 확인
kubectl describe hpa your-app-hpa

# 리소스 사용률 확인
kubectl top pods -n your-namespace
```

**문제 2: 노드 감축이 되지 않음**
```bash
# PDB 상태 확인
kubectl get pdb -A

# 노드의 파드 분포 확인
kubectl get pods -o wide --field-selector spec.nodeName=node-name

# Cluster Autoscaler 로그 확인
kubectl logs -n kube-system deployment/cluster-autoscaler
```

## 5. 비용 최적화 고려사항

### 리소스 효율성 극대화

```yaml
# 효율적인 리소스 설정
resources:
  requests:                 # 실제 사용량 기준으로 설정
    memory: "1Gi"
    cpu: "500m"
  limits:                   # 버스트 허용량
    memory: "2Gi"
    cpu: "1000m"
```

### 스케일링 비용 분석

- **HPA 스케일 업 비용**: 파드 추가 시 즉시 비용 발생
- **노드 스케일 업 비용**: 새 노드 프로비저닝 시간 (2-5분) 고려
- **스케일 다운 시점**: 트래픽 패턴 분석으로 최적 타이밍 결정

## 결론

Kubernetes에서 고가용성과 안정성을 확보하는 것은 **HPA, PDB, Cluster Autoscaler의 유기적 연동**이 핵심입니다.

### 핵심 원칙
1. **여유 있는 리소스 계획**: 노드 70%, HPA 60% 임계치 적용
2. **단계적 스케일링**: 파드 → 노드 순서의 자동 확장
3. **가용성 우선**: PDB로 최소 서비스 레벨 보장
4. **지속적 모니터링**: 알람과 메트릭 기반 사전 대응

### 운영 체크리스트
- [ ] HPA 메트릭 정상 수집 확인
- [ ] PDB 설정으로 업데이트 가능성 검증
- [ ] Cluster Autoscaler 이벤트 모니터링
- [ ] 리소스 사용률 임계치 주기적 검토
- [ ] 비용 대비 성능 최적화 분석

다음 포스트에서는 **"Kubernetes 멀티 클러스터 Ingress 아키텍처 설계"**에 대해 다루겠습니다.