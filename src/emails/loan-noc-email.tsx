import { Heading, Text } from "@react-email/components";

import { EmailLayout, emailText } from "@/emails/email-layout";

export type LoanNocEmailProps = {
  employeeName: string;
  organizationName: string;
  /** "loan" or "salary advance". */
  kind: string;
  amount: string;
  reference: string;
};

export const LoanNocEmail = (props: LoanNocEmailProps) => (
  <EmailLayout preview={`Your no objection certificate ${props.reference}`} organizationName={props.organizationName}>
    <Heading as="h1" style={emailText.heading}>Your {props.kind} is fully repaid</Heading>
    <Text style={emailText.paragraph}>Hello {props.employeeName},</Text>
    <Text style={emailText.paragraph}>
      Your {props.kind} of {props.amount} with {props.organizationName} is closed. Your no objection certificate
      (reference {props.reference}) is attached. Keep it for your records.
    </Text>
  </EmailLayout>
);

LoanNocEmail.PreviewProps = {
  employeeName: "Asha Verma",
  organizationName: "Acme Textiles",
  kind: "loan",
  amount: "INR 50,000.00",
  reference: "NOC-1A2B3C4D",
} satisfies LoanNocEmailProps;

export default LoanNocEmail;
