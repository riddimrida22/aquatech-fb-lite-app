from collections.abc import Callable

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from .db import get_db
from .models import User

PERMISSIONS_BY_ROLE: dict[str, set[str]] = {
    "employee": set(),
    "manager": {
        "VIEW_FINANCIALS",
        "MANAGE_PROJECTS",
        "MANAGE_WBS",
        "APPROVE_TIMESHEETS",
        "MANAGE_RATES",
        "MANAGE_COST_PROFILES",
    },
    "admin": {
        "VIEW_FINANCIALS",
        "MANAGE_PROJECTS",
        "MANAGE_WBS",
        "APPROVE_TIMESHEETS",
        "MANAGE_RATES",
        "MANAGE_COST_PROFILES",
        "MANAGE_INVOICE_TEMPLATES",
        "MANAGE_ACCOUNTING_RULES",
        "RUN_MONTH_CLOSE_EXPORT",
        "MANAGE_TIMEFRAMES",
        "MANAGE_USERS",
    },
}


def permissions_for_role(role: str) -> set[str]:
    return PERMISSIONS_BY_ROLE.get(role, set())


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User is inactive")
    return user


def require_permission(permission: str) -> Callable[[User], User]:
    def _checker(current_user: User = Depends(get_current_user)) -> User:
        perms = permissions_for_role(current_user.role)
        if permission not in perms:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Missing permission: {permission}")
        return current_user

    return _checker
