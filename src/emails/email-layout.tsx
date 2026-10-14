import type { ReactNode } from "react";
import { Body, Container, Head, Hr, Html, Preview, Section, Text } from "@react-email/components";

const styles = {
  body: { backgroundColor: "#f4f4f5", fontFamily: "Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif", margin: 0 },
  container: { maxWidth: "560px", margin: "32px auto", backgroundColor: "#ffffff", borderRadius: "12px", overflow: "hidden", border: "1px solid #e4e4e7" },
  header: { backgroundColor: "#18181b", padding: "20px 32px" },
  brand: { color: "#ffffff", fontSize: "18px", fontWeight: 700, margin: 0 },
  organization: { color: "#a1a1aa", fontSize: "13px", margin: "4px 0 0" },
  content: { padding: "28px 32px 8px" },
  footer: { color: "#71717a", fontSize: "12px", lineHeight: "18px", padding: "0 32px 24px", margin: 0 },
};

/** Frame shared by every document email: brand header, the message, and a footer explaining the attachment. */
export const EmailLayout = ({
  preview,
  organizationName,
  children,
}: {
  preview: string;
  organizationName: string;
  children: ReactNode;
}) => (
  <Html lang="en">
    <Head />
    <Preview>{preview}</Preview>
    <Body style={styles.body}>
      <Container style={styles.container}>
        <Section style={styles.header}>
          <Text style={styles.brand}>HazriPro</Text>
          <Text style={styles.organization}>{organizationName}</Text>
        </Section>
        <Section style={styles.content}>{children}</Section>
        <Hr style={{ borderColor: "#e4e4e7", margin: "16px 32px" }} />
        <Text style={styles.footer}>
          The document is attached as a PDF. This email was sent by HazriPro on behalf of {organizationName}.
          If you did not expect it, contact your HR team.
        </Text>
      </Container>
    </Body>
  </Html>
);

export const emailText = {
  heading: { color: "#18181b", fontSize: "20px", fontWeight: 600, margin: "0 0 12px" },
  paragraph: { color: "#3f3f46", fontSize: "14px", lineHeight: "22px", margin: "0 0 12px" },
  label: { color: "#71717a", fontSize: "13px", margin: 0 },
  value: { color: "#18181b", fontSize: "14px", fontWeight: 600, margin: 0, textAlign: "right" as const },
};
