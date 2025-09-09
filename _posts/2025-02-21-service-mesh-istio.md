---
layout: post
title: "Service Mesh (Istio)"
date: 2025-02-21 13:15:00 +0000
categories: [tech]
tags: [tech, istio, service-mesh]
excerpt: "컨테이너 애플리케이션의 배포, 확장, 관리를 자동화하는 Orchestration System"
notion_id: 1a1eef64-a1ca-80d5-a5aa-f50d5e3e58ec
notion_url: https://www.notion.so/Service-Mesh-Istio-1a1eef64a1ca80d5a5aaf50d5e3e58ec
---

# Overview

## Kubernetes

- 컨테이너 애플리케이션의 배포, 확장, 관리를 자동화하는 Orchestration System
- 다수의 컨테이너를, 다수의 시스템에서, 각각의 목적에 따라 배포, 복제, 장애 복구

<!--more-->
## 왜 생겨났을까?

### MSA

- 소프트웨어 시스템을 여러 개의 작은, 독립적인 서비스로 분할하여 개발하고 운영하는 아키텍처
- 장점
- 단점
# Service Mesh

- 애플리케이션의 서비스 간 모든 통신을 처리하는 소프트웨어 계층
- 메시(Mesh) → 망사 그물
- Proxy
## Service Mesh의 필요성과 역할

- 자동화된 서비스 간 통신 관리
- 서비스 간 통신의 암호화
- 통신 실패에 대한 관리
- 서비스 간 트래픽 관리
- 서비스 간 통신에 대한 모니터링, 로깅
- Linkerd, Consul, Kuma, AWS App Mesh, Istio
# Istio

- 가장 널리 사용되는 오픈소스 서비스 메시 도구
- Since 2016, Google, IBM, Lyft
- CNCF의 졸업 프로젝트
## 주요 기능

- 트래픽 관리
- 보안
- 정책 관리
- 모니터링 로깅
- 장애 복구 및 회복력
## 장단점

- 장점
- 단점
## 구성 요소

### Data Plane

- 워크로드 인스턴스 간의 트래픽을 직접 처리하고 라우팅하는 메시의 일부
- 마이크로서비스 간의 모든 네트워크 통신을 중재하고 제어하는 프록시 세트
- 모든 메시 트래픽에 대한 원격 측정을 수집하고 보고
### Data Plane - Proxy (Envoy)

- Data Plane의 핵심 역할을 담당하는 고성능 오픈소스 프록시 (CNCF의 또다른 졸업 프로젝트)
- 각 마이크로서비스(Pod)에 사이드카(Sidecar) 패턴으로 배치
- 각 서비스의 모든 네트워크 트래픽을 가로채어 제어
### Control Plane

- Data Plane이 제대로 동작하도록 관리, 제어하는 역할
- 과거 Pilot, Citadel, Gallery, Mixer의 역할을 istiod라는 단일 프로세스로 통합
### Pilot

- 트래픽 관리 및 서비스 디스커버리 기능
- Envoy Proxy에 트래픽 라우팅 규칙을 전달
### Citadel

- 보안 관리 기능 담당
- mTLS를 통해 서비스 간 안전한 통신 보장
- TLS 인증서 발급 및 관리
### Gallery

- 서비스 메시의 설정파일을 관리하고 일관되게 배포
- 설정이 올바르게 작성되었는지 유효성 검증
- 설정관리의 일관성과 안정성 보장
### Istiod

- Pilot, Citadel, Gallery, Mixer 등 여러 독립 구성요소를 통합
- 1.6에 단일 Control Plane 도입
- 배포 및 운영 간소화
- 성능 향상
- 리소스 절감
## Sidecar and Ambient

- Ambient 모드
## 설치

- Istioctl을 사용 (권장)
- Helm 차트로 배포
# Traffic Management

- 마이크로서비스 간의 트래픽을 제어하고 최적화하는 기능을 제공
- 트래픽 관리 API 리소스
## 요청 흐름

### 외부

- 외부 요청 → Istio Gateway (Envoy) → 대상 서비스의 Envoy 사이드카 → 서비스 컨테이너
### 내부 서비스 간 컨테이너

- 출발지 서비스 컨테이너 → 출발지 서비스의 Envoy 사이드카 → 대상 서비스의 Envoy 사이드카 → 대상 서비스 컨테이너
## Gateway

- 클러스터 외부와 내부간 트래픽 관리 역할
- 종류
- VirtualService와 연동하여 트래픽을 더욱 세밀하게 라우팅
### 주요 필드

- **selector**: 어떤 게이트웨이 컨트롤러가 이 구성을 관리할지 지정
- **servers**: 게이트웨이가 노출할 서버 목록
## Virtual Service

- istio에서 트래픽을 어디로, 어떻게 라우팅할지 제어하는 리소스
- Istio의 트래픽 관리를 담당하는 핵심 리소스
### 주요 필드

- **hosts**: 이 VirtualService가 적용될 대상 호스트
- **gateways**: 이 규칙이 적용될 게이트웨이 목록
- **http**: HTTP 트래픽 라우팅 규칙
### 주요 사용 사례

- 버전별 트래픽 분배 및 카나리 배포
- 헤더 기반 라우팅
## Destination Rule

- istio에서 트래픽이 목적지 Service에 도달할 때 해당 Service가 어떻게 트래픽을 처리할지 제어
- Virtual Service는 트래픽을 어디로 보낼 지에 초점
- Destination Rule은 트래픽이 도착한 후 어떻게 처리할지 정의
- 주요 기능
### 주요 필드

- **host**: 이 규칙이 적용될 서비스
- **trafficPolicy**: 전체 서비스에 적용되는 트래픽 정책
- **subsets**: 서비스의 특정 버전 또는 라벨에 따라 정의, 특정 버전의 서비스 인스턴스에 트래픽을 분배
### 주요 사용 사례

- 버전별 트래픽 관리
- 서비스 안정성 향상
- 트래픽 분배 최적화
- 연결 풀 관리로 성능 최적화
- 보안 강화

---

*Originally published in [Notion](https://www.notion.so/Service-Mesh-Istio-1a1eef64a1ca80d5a5aaf50d5e3e58ec) on February 21, 2025*