# OKRs: Agent Freelance Marketplace — Валидация

## Objective

Определить, стоит ли Mingles строить Agent Task Exchange, и если да — запустить MVP с первыми живыми транзакциями в течение 90 дней.

---

## Phase 0: Validation (Weeks 1-2)

**O: Подтвердить или опровергнуть demand до написания кода**

- **KR1:** Провести 5+ customer discovery разговоров с разработчиками, использующими Gonka Gateway — есть ли у них нужда в external agent delegation
- **KR2:** Найти 3+ реальных use cases где агент из OpenClaw нанимает внешнего агента (не просто теоретически)
- **KR3:** Определить ≥1 компанию-партнёра готовую стать первым demand-side клиентом

**Метрика успеха:** ≥3 из 5 разработчиков подтверждают нужду → идём в MVP

---

## Phase 1: MVP Build (Weeks 2-8)

**O: Запустить минимальную работающую биржу задач**

- **KR1:** Agent Task Board API (POST /tasks, GET /tasks, x402 billing) задеплоен и доступен публично
- **KR2:** ≥5 агентов OpenClaw зарегистрированы как providers в registry
- **KR3:** ≥1 end-to-end transaction: Agent A publishes task → Agent B completes → x402 payment settles

**Метрика успеха:** Первая live transaction до конца Week 8

---

## Phase 2: Traction (Months 2-3)

**O: Доказать, что marketplace работает за пределами internal test**

- **KR1:** ≥10 внешних разработчиков зарегистрировали agent на платформе
- **KR2:** ≥50 task transactions за первый месяц после launch
- **KR3:** Gross Transaction Volume (GTV) ≥ $500 за первый месяц (MRR ~$25-50 при 5% fee)
- **KR4:** ≥1 публичный кейс (блог/Twitter) с конкретными числами

**Метрика успеха:** GTV растёт неделя к неделе

---

## Measurement Plan

| KR | Инструмент | Частота |
|----|-----------|---------|
| Customer interviews | Google Meet/Calendly | Недели 1-2 |
| API transaction logs | Gonka Gateway logs | Real-time |
| x402 payment settlements | Base blockchain explorer | Real-time |
| Agent registrations | Platform DB | Daily |
| GTV | Internal dashboard | Weekly |

**Первая ревизия OKRs:** через 14 дней после launch MVP (конец Phase 1)

---

## Go/No-Go Criteria

**GO** (строим полноценный продукт) если после Phase 1:
- ≥10 external agent registrations
- ≥1 paying external customer
- Positive feedback в 3+ customer conversations

**PIVOT** если:
- Нет external agents после 4 недель публичного beta
- Demand только от internal OpenClaw agents

**STOP** если:
- Phase 0 validation shows < 2 из 5 разработчиков видят value
- Olas Mech Marketplace захватывает весь addressable market до MVP launch
