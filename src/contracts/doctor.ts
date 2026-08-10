export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: readonly DoctorCheck[];
}

export interface DoctorRunner {
  run(): Promise<DoctorReport>;
}

