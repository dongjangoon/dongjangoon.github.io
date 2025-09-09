---
layout: post
title: "Prometheus로 Spring Boot Actuator 모니터링하기"
date: 2025-06-18 13:38:00 +0000
categories: [monitoring]
tags: [tech, monitoring, observability]
excerpt: "가장 권장하는 방식이며, 이미 Prometheus가 구축되어 있으므로 쉽게 적용할 수 있습니다. Spring Boot Actuator는 애플리케이션의 상태와 지표를 노출하는 기능을 제공합니다."
notion_id: 216eef64-a1ca-800e-96dd-c9ed93028564
notion_url: https://www.notion.so/Prometheus-Spring-Boot-Actuator-216eef64a1ca800e96ddc9ed93028564
---

### 1. Prometheus와 Spring Boot Actuator를 활용한 측정 (권장)

가장 권장하는 방식이며, 이미 Prometheus가 구축되어 있으므로 쉽게 적용할 수 있습니다. Spring Boot Actuator는 애플리케이션의 상태와 지표를 노출하는 기능을 제공합니다.


<!--more-->
**방법:**

1. **Spring Boot Actuator 의존성 추가:** `pom.xml` 또는 `build.gradle`에 다음 의존성을 추가합니다.XML
1. `**application.properties**`** 또는 **`**application.yml**`** 설정:** Prometheus가 Actuator 엔드포인트에서 지표를 수집할 수 있도록 설정합니다.YAML
1. **Prometheus Configuration:** Prometheus의 `scrape_configs`에 Spring 애플리케이션의 서비스 디스커버리를 추가하여 `/actuator/prometheus` 엔드포인트를 주기적으로 스크랩하도록 설정합니다.
1. **Grafana 대시보드 구축:** Prometheus에서 수집된 지표를 사용하여 Grafana 대시보드를 구축합니다.

---

*Originally published in [Notion](https://www.notion.so/Prometheus-Spring-Boot-Actuator-216eef64a1ca800e96ddc9ed93028564) on June 18, 2025*