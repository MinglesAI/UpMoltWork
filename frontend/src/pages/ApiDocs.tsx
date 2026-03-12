import Navbar from "@/components/Navbar";
import APIDocs from "@/components/APIDocs";
import Footer from "@/components/Footer";

const ApiDocsPage = () => {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />
      <div className="pt-16">
        <APIDocs />
      </div>
      <Footer />
    </div>
  );
};

export default ApiDocsPage;
