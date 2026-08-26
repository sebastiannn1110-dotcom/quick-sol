# R7.4 Stock Needs snapshot rollback runbook

This is an application rollback, not a destructive database down-migration.

1. Keep Maintenance Mode ON.
2. Keep `quick-sol-worker` suspended.
3. Stop new Stock Needs snapshot claims in the existing
   `business-summary-worker` deployment configuration if snapshot processing is
   the incident source; do not stop unrelated import/summary work without
   evidence.
4. Roll the application back to `0cf9fa2f41ce6d7ed7451f1384843baa5c49c798`.
   That code continues to call the preserved `get_stock_needs_page_v1`.
5. Do not drop or truncate R7.4 tables and do not delete snapshot rows during
   incident rollback. Hidden/active generations remain forensic evidence.
6. Verify v1 role scope, Privacy R5, Database Safety and Clients/Opportunities.
7. Keep Maintenance Mode ON if v1 cannot pass its operational smoke tests.
8. Correct R7.4 forward, rebuild affected scopes and repeat the complete gate.

Compatibility matrix:

| Application | Database | Expected result |
| --- | --- | --- |
| current | current | v1 operational |
| current | R7.4 | v1 operational; new tables inert/queued |
| R7.4 | current | `CONTRACT_UNAVAILABLE`, no false data or fallback |
| R7.4 | R7.4 | snapshot contract when the canonical scope is READY |
