import { Column, Heading, Row, Section, Text } from "@react-email/components";

import { EmailLayout, emailText } from "@/emails/email-layout";

export type SalarySlipEmailProps = {
  employeeName: string;
  organizationName: string;
  period: string;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
};

const Line = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <Row style={{ padding: "8px 0", borderTop: strong ? "1px solid #e4e4e7" : undefined }}>
    <Column>
      <Text style={emailText.label}>{label}</Text>
    </Column>
    <Column>
      <Text style={{ ...emailText.value, fontSize: strong ? "16px" : "14px" }}>{value}</Text>
    </Column>
  </Row>
);

export const SalarySlipEmail = (props: SalarySlipEmailProps) => (
  <EmailLayout preview={`Your salary slip for ${props.period}`} organizationName={props.organizationName}>
    <Heading as="h1" style={emailText.heading}>Your salary slip is ready</Heading>
    <Text style={emailText.paragraph}>Hello {props.employeeName},</Text>
    <Text style={emailText.paragraph}>
      Your salary slip from {props.organizationName} for {props.period} is attached. Here is a summary:
    </Text>
    <Section style={{ backgroundColor: "#fafafa", borderRadius: "8px", padding: "8px 16px", margin: "8px 0 12px" }}>
      <Line label="Gross pay" value={props.grossPay} />
      <Line label="Total deductions" value={props.totalDeductions} />
      <Line label="Net pay" value={props.netPay} strong />
    </Section>
  </EmailLayout>
);

SalarySlipEmail.PreviewProps = {
  employeeName: "Asha Verma",
  organizationName: "Acme Textiles",
  period: "1 Oct 2026 to 31 Oct 2026",
  grossPay: "INR 32,500.00",
  totalDeductions: "INR 2,140.00",
  netPay: "INR 30,360.00",
} satisfies SalarySlipEmailProps;

export default SalarySlipEmail;
