---
layout: single
title: "About"
permalink: /about/
author_profile: true
sidebar:
  nav: "main"
toc: true
toc_sticky: true
---

# 안녕하세요!

DevOps와 SRE 개발자 김동현입니다. 좋은 아키텍처와 좋은 커뮤니케이션이란 무엇일까에 대해 고민하고 있습니다.

DevOps를 통해 더욱 편리한 개발 환경을 갖추고 모니터링의 표준화를 통해 문제 해결에 접근하는 것에 관심이 많습니다.

---

## Contact

- **Email**: [easygoinglife2@gmail.com](mailto:easygoinglife2@gmail.com)
- **Blog**: [https://dongjangoon.github.io/](https://dongjangoon.github.io/)
- **GitHub**: [github.com/dongjangoon](https://github.com/dongjangoon)

---

## Career

### LG CNS - AI아키텍처 팀
**Application Architect** | *2025.01 - Present*

#### XXX 기관 Gen AI 플랫폼 구축 프로젝트 (2025.07 -)
- NHN Cloud NKS의 PaaS 환경과 IaaS 환경에서의 Outer Architecture(K8s, Redis, Monitoring, Logging, Tracing) 부분을 담당
- K8s 환경에서 GPU 노드를 사용하는 솔루션 설치 및 gpu-operator와 vllm을 통한 LLM 모델의 서빙을 구축
- H100 SMX, Nvidia Driver 575.57.08, CUDA 12.8 환경에서 작업
- 외부망과 내부망을 동시에 사용해야 하는 상황에서 CoreDNS 설정을 통해 내부 DNS 서버 및 멀티 클러스터 통신 환경 구축
- Grafana, Prometheus, Opentelemetry Agent, Collector, Jaeger, EFK(OpenSearch 사용)으로 멀티 클러스터 환경에서 표준 모니터링 시스템 구축
- Redis Instance 3개를 엮어 쿼럼을 갖춘 Sentinel 구성을 통해 HA 보장

#### XX은행 Gen AI 플랫폼 구축 프로젝트 (2025.02 -)
- 사내 문서 및 데이터를 기반으로 한 전사적 업무 자동화 및 업무 도움 AI 플랫폼 구축 프로젝트
- 온프레미스 K8s 기반 환경에서 Frontend, Backend, 자사 AI 서비스 플랫폼 및 여러 솔루션의 CI/CD 환경 구성 (Gitlab CI/CD)
- Grafana, Prometheus, Loki, Promtail, Opentelemetry Agent, Collector와 Tempo로 표준 모니터링 및 알림 체계 구축
- vllm, dcgm-exporter 등으로 LLM 모니터링 → KV Cache, token output, process hang 여부 등을 모니터링하고 이를  통해 기존 TP1이던 GPU 구성을 TP2 구성으로 최적화 및 vllm context-length, batch size 등 파라미터 조절로 성능 최적화 경험

---

## Tech Stack

**DevOps & Infrastructure**
- Kubernetes (AWS, NHN Cloud, On-premise), Helm, Docker
- Prometheus, Grafana, EFK (OpenSearch), Loki, Tempo, Thanos, OpenTelemetry, K6
- vllm, LLMOps
- Redis, Nginx
- Git, GitLab, GitHub Actions, Tekton, ArgoCD

**Programming & Frameworks**
- Linux, Shell Script, Python
- Java, Kotlin & Spring
- TypeScript & NestJS

---

## Certifications

- **Certified Kubernetes Administrator (CKA)** (2024.11.08)

---

## Languages

- **Korean**: Native
- **English**: TOEIC SPEAKING Advanced Low  
- **Japanese**: JLPT N3

---

## Education

**Seoul National University** | *Graduated February 2025*

- **Bachelor of Science in Earth and Environmental Sciences** (2017 - 2025)
- **Bachelor of Science in Computational Sciences** (Interdisciplinary Major) (2022 - 2025)

---

## Areas of Interest

현재 **SRE, DevOps, LLMOps, AIOps** 분야에 특별한 관심을 갖고 있으며, 다음과 같은 영역에서 전문성을 키워나가고 있습니다:

- **Site Reliability Engineering (SRE)**: 안정적이고 확장 가능한 서비스 운영
- **DevOps**: 개발과 운영의 효율적인 통합 및 자동화
- **LLMOps**: 대규모 언어 모델의 효율적인 배포 및 운영
- **AIOps**: AI를 활용한 지능형 운영 시스템 구축

---

*더 자세한 프로젝트 경험과 기술적 세부사항은 [GitHub](https://github.com/dongjangoon)와 [Blog](https://dongjangoon.github.io/)에서 확인하실 수 있습니다.*
