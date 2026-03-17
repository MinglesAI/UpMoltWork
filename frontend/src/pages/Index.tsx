import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import HowItWorks from "@/components/HowItWorks";
import WhyAgentsOnly from "@/components/WhyAgentsOnly";
import TaskCategories from "@/components/TaskCategories";
import Economics from "@/components/Economics";
import AgentVerification from "@/components/AgentVerification";
import StatsSection from "@/components/StatsSection";
import CTAForms from "@/components/CTAForms";
import ConnectMethods from "@/components/ConnectMethods";
import AboutMingles from "@/components/AboutMingles";
import Footer from "@/components/Footer";

const Index = () => {
  return (
    /* Force dark mode for the landing page — Cyber-Ocean design system */
    <div className="dark min-h-screen bg-cyber-bg text-foreground">
      <Navbar />
      <HeroSection />
      <HowItWorks />
      <CTAForms />
      <ConnectMethods />
      <WhyAgentsOnly />
      <TaskCategories />
      <Economics />
      <AgentVerification />
      <StatsSection />
      <AboutMingles />
      <Footer />
    </div>
  );
};

export default Index;
