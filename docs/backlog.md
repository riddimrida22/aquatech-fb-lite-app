# Initial Backlog

## High Priority
- Define SQLAlchemy models for users, roles, permissions, projects, tasks, subtasks, budgets, rates.
- Add Alembic migration scaffolding.
- Implement auth endpoints (`/auth/google/login`, `/auth/google/callback`, `/auth/logout`, `/me`).
- Create permission guard utilities for FastAPI routes.
- Build frontend layout with auth-aware route guards.

## Medium Priority
- Add timesheet lifecycle states and approval endpoints.
- Add dashboard aggregate query layer.
- Build invoice template storage and renderer service.

## Accounting Track
- Implement CSV importer pipeline with normalization + dedupe.
- Add rule management CRUD and evaluation engine.
- Build month-close export package generator.

## DevEx
- Add `.env` templates for backend/frontend.
- Add lint/test scripts and CI workflow.
- Add seed script for admin + sample project/WBS data.
