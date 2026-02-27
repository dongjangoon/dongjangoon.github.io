---
layout: single
title: "Prometheus 이중화 + Thanos 설치 가이드"
date: 2025-06-11 11:44:00 +0000
last_modified_at: 2026-02-17
categories: [monitoring]
tags: [prometheus, thanos, monitoring, high-availability, kubernetes]
excerpt: "Thanos와 Prometheus를 활용한 고가용성 모니터링 시스템 구축 및 이중화 설정 방법을 알아봅니다."
---

## 아키텍처 개요

Prometheus 이중화와 Thanos를 결합하면 고가용성 모니터링 시스템을 구축할 수 있습니다.

<!--more-->

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Thanos 통합 모니터링 시스템                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │   Thanos Query  │    │ Thanos Query FE │    │  Grafana UI     │  │
│  │  (HA Querier)   │◄───┤   (Frontend)    │◄───┤   Dashboard     │  │
│  │  Port: 19192    │    │   Port: 9090    │    │   Port: 3000    │  │
│  └────────┬────────┘    └─────────────────┘    └─────────────────┘  │
│           │                                                         │
│           ▼                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                    Thanos Store Gateway                         ││
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐   ││
│  │  │Thanos Sidecar │  │Thanos Sidecar │  │  Thanos Store     │   ││
│  │  │(Prometheus 1) │  │(Prometheus 2) │  │ (Object Storage)  │   ││
│  │  └───────┬───────┘  └───────┬───────┘  └─────────┬─────────┘   ││
│  └──────────┼──────────────────┼────────────────────┼─────────────┘│
│             ▼                  ▼                    ▼              │
│  ┌───────────────┐   ┌───────────────┐   ┌─────────────────┐       │
│  │ Prometheus 1  │   │ Prometheus 2  │   │   MinIO/S3      │       │
│  │ (Worker 1)    │   │ (Worker 2)    │   │ Object Storage  │       │
│  └───────────────┘   └───────────────┘   └─────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

### 구성 요소

| 컴포넌트 | 역할 |
|---------|------|
| Prometheus | 메트릭 수집 및 단기 저장 (15일) |
| Thanos Sidecar | Prometheus 데이터를 Object Storage에 업로드 |
| Thanos Store | Object Storage의 데이터를 쿼리에 제공 |
| Thanos Query | 여러 데이터 소스를 통합 쿼리 |
| Thanos Compact | 데이터 다운샘플링 및 압축 |
| MinIO/S3 | 장기 데이터 저장소 |

---

## 설치 과정

### 1단계: MinIO 설치

#### EBS CSI Driver IAM Policy 적용

워커 노드에 `AmazonEBSCSIDriver` Policy가 적용된 IAM Role을 연결합니다.

#### gp3 StorageClass 생성

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  fsType: xfs
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

#### MinIO Helm 배포

```bash
# 네임스페이스 생성
kubectl create namespace minio

# Helm 저장소 추가
helm repo add minio https://charts.min.io/
helm repo update

# Chart 다운로드 및 values 수정
helm pull minio/minio --untar
# values.yaml에서 rootUser, rootPassword 설정

# 설치
helm install minio minio/minio -n minio -f values.yaml
```

#### Thanos 버킷 생성

```bash
# MinIO 클라이언트로 버킷 생성
kubectl exec -n minio sts/minio -- mc alias set local http://localhost:9000 minio minio123
kubectl exec -n minio sts/minio -- mc mb local/thanos --ignore-existing
kubectl exec -n minio sts/minio -- mc ls local/
```

---

### 2단계: Object Storage 설정

Thanos가 사용할 Object Storage 설정을 Secret으로 생성합니다.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: thanos-objstore-config
  namespace: monitoring
type: Opaque
stringData:
  objstore.yml: |
    type: S3
    config:
      bucket: "thanos"
      endpoint: "minio.minio.svc.cluster.local:9000"
      access_key: "minioadmin"
      secret_key: "minioadmin"
      insecure: true
```

---

### 3단계: Prometheus 이중화 설정

Prometheus Operator의 `values.yaml`에 다음 설정을 적용합니다.

```yaml
prometheus:
  prometheusSpec:
    replicas: 2
    externalLabels:
      cluster: "production"
      region: "ap-northeast-2"
    thanos:
      create: true
      version: v0.38.0
      objectStorageConfig:
        name: thanos-objstore-config
        key: objstore.yml
    retention: 15d
    retentionSize: 20GB
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: 1
        memory: 2Gi
    storageSpec:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 30Gi
    # Pod Anti-Affinity로 다른 노드에 배치
    affinity:
      podAntiAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchExpressions:
              - key: app.kubernetes.io/name
                operator: In
                values:
                - prometheus
            topologyKey: kubernetes.io/hostname
```

---

### 4단계: Thanos Helm 설치

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install thanos bitnami/thanos -n monitoring -f thanos-values.yaml
```

#### 연결 상태 검증

```bash
# Thanos Query UI 접속
kubectl port-forward -n monitoring svc/thanos-query 9090:9090 &

# 브라우저에서 localhost:9090 접속
# Status > Stores 탭에서 연결된 스토어 확인:
# - Sidecar (2개)
# - Store Gateway (1개)
```

---

## 데이터 보존 정책

### 단기 데이터 (Prometheus)

| 항목 | 설정 |
|------|------|
| 보존 기간 | 15일 |
| 스크래핑 간격 | 30초 |
| 스토리지 | 인스턴스당 30GB |

### 장기 데이터 (Thanos Object Storage)

| 항목 | 설정 |
|------|------|
| 보존 기간 | 1년 |
| 다운샘플링 | 5분 → 1시간 해상도 |
| 예상 스토리지 | ~500GB (1년 기준) |

---

## 고가용성 설계

### 데이터 일관성

- 각 Prometheus 인스턴스는 동일한 타겟을 스크래핑
- External labels로 인스턴스 구분 (`replica: A, B`)
- Thanos Query가 중복 제거 수행

### 장애 대응 시나리오

| 장애 상황 | 대응 |
|----------|------|
| Prometheus 1개 인스턴스 다운 | 나머지 인스턴스가 계속 수집 |
| Object Storage 접근 불가 | 최근 15일 데이터는 로컬에서 조회 가능 |
| Thanos Query 장애 | 다중 replica로 가용성 보장 |

---

## 모니터링 및 알람

### 핵심 메트릭

```promql
# Prometheus 인스턴스 상태
up{job="prometheus"}

# Sidecar 연결 상태
thanos_sidecar_prometheus_up

# Object Storage 작업
thanos_objstore_bucket_operations_total

# Query 부하
thanos_query_concurrent_selects
```

### 권장 알람 규칙

| 알람 | 조건 |
|------|------|
| PrometheusDown | `up{job="prometheus"} == 0` for 5m |
| ThanosSidecarDown | `thanos_sidecar_prometheus_up == 0` for 5m |
| ObjectStorageUploadFailed | `rate(thanos_objstore_bucket_operation_failures_total[5m]) > 0` |
| PrometheusDiskFull | `prometheus_tsdb_storage_blocks_bytes / prometheus_tsdb_retention_limit_bytes > 0.9` |
