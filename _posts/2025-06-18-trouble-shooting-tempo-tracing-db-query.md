---
layout: single
title: "Trouble Shooting: Tempo Tracing DB Query"
date: 2025-06-18 12:53:00 +0000
categories: monitoring
tags: [tech]
excerpt: "hikariCP에서 커넥션을 유지하는 쿼리가 요청이 다 처리된 후에도 30분 주기로 발생함. 최종적으로 특정 요청이 굉장히 길게 걸린 것처럼 트레이스가 표시됨 (19h, 1h)"
notion_id: 216eef64-a1ca-8093-bcc5-e2b4ae0db10b
notion_url: https://www.notion.so/Trouble-Shooting-Tempo-Tracing-DB-Query-216eef64a1ca8093bcc5e2b4ae0db10b
---

## 문제

- `hikariCP`에서 커넥션을 유지하는 쿼리가 요청이 다 처리된 후에도 30분 주기로 발생함. → 최종적으로 특정 요청이 굉장히 길게 걸린 것처럼 트레이스가 표시됨 (19h, 1h)
- `Spring`의  `hikari` 설정에서 `connection-init-sql`로 설정한 쿼리로 `db.statement`는 `"SET application_name = ?`, thread.name은 `HikariPool-1 connection adder`

<!--more-->
- 이때 `thread.id`는 매번 변경됨.
```yaml
hikari:
	data-source-properties:
    applicationName: ATGH-BATCH
  pool-name: app
  maximum-pool-size: 100
  minimum-idle: 50
  max-lifetime: 1800000
  connection-timeout: 30000
  connection-init-sql: SET application_name = 'AIGN-BATCH'
  connection-test-query: select 1 
```

- 유휴 커넥션을 최소 50개로 유지하기 위해 발생하는 쿼리
- 다만, **이미 트랜잭션이 커밋된 요청에 대해서 같은 트레이스 ID로 수집되는 것이 문제**

## 원인

### HikariCP 내부 동작

- `minimum-idle` 값은 커넥션 풀에 유지할 최소 유휴 커넥션 수
- 유휴 커넥션 수가 50미만이 되면 HikariCP가 내부적으로, 백그라운드로 커넥션을 추가하는 작업을 수행하고, 이게 `HIkariPool-1 connection adder` 스레드에 해당함
- 여기서 설정된 `max-lifetime` 이 1800000이므로 30분 주기로 해당 스레드에서 `connection-init-sql` 쿼리가 발생함
- 이 작업을 할 때마다 새로운 스레드를 사용하므로 thread.id는 매번 변경됨

### 왜 트랜잭션이 커밋된 후에도, 해당 요청과 같은 trace id로 계측되는가?

- Opentelemetry Agent는 백그라운드 작업을 계측하면서, 적절한 부모 span을 찾지 못할 때, 트레이스의 루트 span에 연결하는 전략을 사용함

---

*Originally published in [Notion](https://www.notion.so/Trouble-Shooting-Tempo-Tracing-DB-Query-216eef64a1ca8093bcc5e2b4ae0db10b) on June 18, 2025*