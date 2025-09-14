---
layout: single
title: "Prometheus 이중화 + Thanos 설치"
date: 2025-06-11 11:44:00 +0000
categories: monitoring
tags: [tech, monitoring, observability]
excerpt: "Thanos와 Prometheus를 활용한 고가용성 모니터링 시스템 구축 및 이중화 설정 방법"
notion_id: 20feef64-a1ca-8002-846e-ebdee3cf8b4b
notion_url: https://www.notion.so/Prometheus-Thanos-20feef64a1ca8002846eebdee3cf8b4b
---

# 1. 아키텍처

```bash
┌─────────────────────────────────────────────────────────────────────┐

<!--more-->
│                        Thanos 통합 모니터링 시스템                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │   Thanos Query  │    │ Thanos Query FE │    │  Grafana UI     │  │
│  │  (HA Querier)   │◄───┤   (Frontend)    │◄───┤   Dashboard     │  │
│  │  Port: 19192    │    │   Port: 9090    │    │   Port: 3000    │  │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘  │
│           │                                                         │
│           ▼                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │                    Thanos Store Gateway                        │ │
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐  │ │
│  │  │Thanos Sidecar │  │Thanos Sidecar │  │  Thanos Store     │  │ │
│  │  │(Prometheus 1) │  │(Prometheus 2) │  │ (Object Storage)  │  │ │
│  │  │Port: 19191    │  │Port: 19291    │  │  Port: 19091      │  │ │
│  │  └───────────────┘  └───────────────┘  └───────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│           │                       │                       │         │
│           ▼                       ▼                       ▼         │
│  ┌───────────────┐      ┌───────────────┐      ┌─────────────────┐  │
│  │ Prometheus 1  │      │ Prometheus 2  │      │   MinIO/S3      │  │
│  │ (Worker 1)    │      │ (Worker 2)    │      │ Object Storage  │  │
│  │ Port: 9090    │      │ Port: 9090    │      │ Port: 9000      │  │
│  └───────────────┘      └───────────────┘      └─────────────────┘  │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │ Thanos Compact  │    │ Thanos Receive  │    │ Thanos Ruler    │  │
│  │ (Compaction)    │    │ (Remote Write)  │    │ (Alert Rules)   │  │
│  │ Port: 19095     │    │ Port: 19291     │    │ Port: 19093     │  │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

# 2. 설치 과정

## 1단계: MinIO 설치

### 1. ebs csi driver 설치를 위한 IAM Policy 적용

- 워커 노드에 `AmazonEBSCSIDriver` Policy가 적용된 IAM Role을 적용함
### 2. S3를 위한 gp3 storageclass 설치

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

### 3. MinIO Helm 배포

```bash
# 네임스페이스 생성
kubectl create namespace minio

# Helm 저장소 추가
helm repo add minio https://charts.min.io/
helm repo update

helm pull minio/minio --untar

# values 조정 - 아래에서 사용할 rootuser, rootpassword 설정
```

### 4. Thanos 버킷 생성

```bash
# MinIO 클라이언트로 버킷 생성
kubectl exec -n minio sts/minio -- mc alias set local http://localhost:9000 minio minio123
kubectl exec -n minio sts/minio -- mc mb local/thanos --ignore-existing
kubectl exec -n minio sts/minio -- mc ls local/
```

## 2단계: Object Storage 설정

- Thanos 저장소 설정
```bash
# Object Storage 설정 생성
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

## 3단계: Prometheus 이중화

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

## 4단계: thanos helm 설치

### Thanos 연결 상태 검증

```bash
# Thanos Query UI 접속
kubectl port-forward -n monitoring svc/thanos-query 9090:9090 &

# 브라우저에서 localhost:9090 접속
# Status > Stores 탭에서 연결된 스토어 확인:
# - Sidecar (2개)
# - Store Gateway (1개)
```

## 4. 데이터 보존 정책

### 단기 데이터 (Prometheus)

- **보존 기간**: 15일
- **스크래핑 간격**: 30초
- **각 인스턴스별 스토리지**: 50GB
### 장기 데이터 (Thanos Object Storage)

- **보존 기간**: 1년
- **다운샘플링**:
- **스토리지 요구량**: ~500GB (1년 기준)
## 5. 고가용성 설계

### 데이터 일관성

- 각 Prometheus 인스턴스는 동일한 타겟을 스크래핑
- External labels로 구분 (replica: A, B)
- Thanos Query가 중복 제거 수행
### 장애 대응

- Prometheus 1개 인스턴스 장애 시 나머지가 계속 동작
- Object Storage 접근 불가 시 최근 15일 데이터는 계속 사용 가능
- Thanos Query 다중 replica로 쿼리 가용성 보장
## 6. 모니터링 및 알람

### 핵심 메트릭

- `up{job="prometheus"}`: Prometheus 인스턴스 상태
- `thanos_sidecar_prometheus_up`: Sidecar 연결 상태
- `thanos_objstore_bucket_operations_total`: Object Storage 작업
- `thanos_query_concurrent_selects`: Query 부하
### 주요 알람 규칙

- Prometheus 인스턴스 다운
- Thanos Sidecar 연결 끊김
- Object Storage 업로드 실패
- 디스크 사용량 90% 초과

---

*Originally published in [Notion](https://www.notion.so/Prometheus-Thanos-20feef64a1ca8002846eebdee3cf8b4b) on June 11, 2025*