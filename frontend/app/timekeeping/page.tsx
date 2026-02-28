import { redirect } from "next/navigation";

export default function TimekeepingPage() {
  redirect("/?timesheet_only=1");
}

