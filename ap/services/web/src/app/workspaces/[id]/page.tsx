"use client";
import { useParams } from "next/navigation";
import { redirect } from "next/navigation";

export default function Page() {
  const { id } = useParams();
  redirect(`/workspaces/${id}/population-setup`);
}
